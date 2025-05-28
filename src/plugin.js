const { plugin, pluginPath, resourcesPath } = require("@eniac/flexdesigner");
const logger = require("./loggerWrapper");
const path = require("path");
const open = require("open");
const { escapeXml } = require("./utils");
const renderer = require("./canvasRenderer");
const keyManager = require("./keyManager");
const ytmApi = require("./ytmApi");

// Global state for tracking YTMusic Desktop playback
let currentPlaybackState = {
  trackId: null,
  isLiked: null,
  lastCheckedTrackId: null,
  isActive: false,
  isPlaying: false,
  progressAtLastUpdate: 0,
  lastApiUpdateTime: 0,
  durationMs: 0,
  songEndTimerId: null, // Timer ID for song end detection
};

// Socket connection related state
let connectionCheckInterval = null;
let lastSocketStateUpdate = 0;

// Rate limiting for state updates
let lastProcessedTime = 0;
let pendingStateUpdate = null;
let stateUpdateTimeout = null;
const STATE_UPDATE_INTERVAL_MS = 500; // 1 second minimum between updates

// Add song end timer functionality
function setupSongEndTimer(progressMs, durationMs, isPlaying) {
  // Clear any existing timer first
  if (currentPlaybackState.songEndTimerId) {
    logger.debug("Clearing existing song end timer");
    clearTimeout(currentPlaybackState.songEndTimerId);
    currentPlaybackState.songEndTimerId = null;
  }

  // Only set up a timer if the song is playing
  if (!isPlaying || !durationMs) {
    logger.debug(
      "Not setting song end timer - playback inactive or no duration"
    );
    return;
  }

  // Calculate remaining time (with a small buffer to ensure we're past the end)
  const remainingMs = Math.max(0, durationMs - progressMs + 200); // 200ms buffer

  logger.debug(
    `Setting song end timer for ${remainingMs}ms (Progress: ${progressMs}ms, Duration: ${durationMs}ms)`
  );

  // Set the timeout to refresh playback state when the song should end
  currentPlaybackState.songEndTimerId = setTimeout(async () => {
    logger.info("Song end timer triggered - requesting current playback state");
    try {
      // Trigger a state update for all YTM keys
      Object.keys(keyManager.activeKeys).forEach((keyId) => {
        const [serialNumber, keyUid] = keyId.split("-");
        const key = keyManager.keyData[keyUid];
        if (key && key.cid && key.cid.includes("ytmdesktop")) {
          if (key.cid === "com.energy.ytmdesktop.nowplaying") {
            updateNowPlayingKey(serialNumber, key);
          }
        }
      });
    } catch (error) {
      logger.error(`Error updating playback after song end: ${error.message}`);
    }
    currentPlaybackState.songEndTimerId = null;
  }, remainingMs);
}

// Add interpolated rendering for now playing keys
async function renderInterpolatedNowPlaying(serialNumber, key) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  logger.debug(`Rendering interpolated state for key: ${keyId}`);

  const currentKeyData = keyManager.keyData[keyUid];
  if (!currentKeyData || !currentKeyData.data) {
    logger.error(
      `Key data or key.data missing for ${keyUid} during interpolated render.`
    );
    keyManager.cleanupKey(serialNumber, keyUid);
    return;
  }

  const {
    currentTrackDetails,
    lastApiUpdateTime,
    progressAtLastUpdate,
    durationMs,
  } = currentKeyData.data;

  const isPlaying = currentPlaybackState.isPlaying;
  let estimatedProgress = progressAtLastUpdate;

  if (isPlaying && lastApiUpdateTime > 0 && durationMs > 0) {
    const elapsed = Date.now() - lastApiUpdateTime;
    estimatedProgress = progressAtLastUpdate + elapsed;
    if (estimatedProgress > durationMs) estimatedProgress = durationMs;
    if (estimatedProgress < 0) estimatedProgress = 0;
  } else if (!isPlaying) {
    estimatedProgress = progressAtLastUpdate;
  } else {
    estimatedProgress = 0;
  }

  const isActive = !!currentTrackDetails;

  try {
    // Use actual track details if available, fallback to meaningful defaults
    const title =
      currentTrackDetails?.title ||
      (currentPlaybackState.isActive ? "Unknown Track" : "Nothing Playing");
    const artist =
      currentTrackDetails?.author ||
      (currentPlaybackState.isActive ? "Unknown Artist" : "");

    logger.debug(
      `Rendering: "${title}" by "${artist}" (Active: ${isActive}, Playing: ${isPlaying})`
    );

    const buttonDataUrl = await renderer.createYoutubeButtonDataUrl(
      currentKeyData.width || 320,
      title,
      artist,
      isPlaying,
      currentTrackDetails?.albumArt || "", // Use actual album art URL if available
      Math.round(estimatedProgress),
      durationMs,
      currentKeyData.style || {},
      true, // showProgress
      true, // showTitle
      true, // showPlayPause
      18, // titleFontSize
      14, // artistFontSize
      true, // showTimeInfo
      10, // timeFontSize
      {}
    );
    keyManager.simpleDraw(serialNumber, currentKeyData, buttonDataUrl);
  } catch (error) {
    logger.error(
      `Error rendering interpolated now playing for ${keyId}: ${error.message}`
    );
    try {
      keyManager.textOnlyDraw(serialNumber, currentKeyData, "Render Error");
    } catch (fallbackError) {
      logger.error(
        `[renderInterpolated] Key ${keyId} - FAILED to draw fallback text: ${fallbackError.message}`
      );
    }
  }
}

// Add periodic update management for now playing keys
function startOrRestartNowPlayingUpdates(serialNumber, key) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  const currentKeyData = keyManager.keyData[keyUid];

  if (!currentKeyData || !currentKeyData.data) {
    logger.error(`Cannot start updates for ${keyId}, key data missing.`);
    return;
  }

  const {
    updateInterval = 4000,
    interpolationIntervalMs = 1000,
    enableInterpolation = true,
  } = currentKeyData.data;

  // Clear existing intervals
  if (keyManager.keyIntervals && keyManager.keyIntervals[keyId]) {
    logger.debug(`Clearing existing API fetch timer for ${keyId}`);
    clearInterval(keyManager.keyIntervals[keyId]);
    delete keyManager.keyIntervals[keyId];
  }
  if (currentKeyData.data.interpolationIntervalId) {
    logger.debug(`Clearing existing interpolation timer for ${keyId}`);
    clearInterval(currentKeyData.data.interpolationIntervalId);
    currentKeyData.data.interpolationIntervalId = null;
  }

  // Initialize keyManager.keyIntervals if it doesn't exist
  if (!keyManager.keyIntervals) {
    keyManager.keyIntervals = {};
  }

  logger.info(
    `Starting API fetch updates for key ${keyId} every ${updateInterval}ms.`
  );
  const apiFetchIntervalId = setInterval(async () => {
    const keyExists =
      keyManager.activeKeys[keyId] && keyManager.keyData[keyUid];
    if (!keyExists) {
      logger.info(
        `Key ${keyId} no longer active/valid, clearing API fetch interval.`
      );
      clearInterval(apiFetchIntervalId);
      delete keyManager.keyIntervals[keyId];
      const latestKeyData = keyManager.keyData[keyUid];
      if (latestKeyData?.data?.interpolationIntervalId) {
        logger.info(
          `Clearing orphaned interpolation interval for inactive key ${keyId}.`
        );
        clearInterval(latestKeyData.data.interpolationIntervalId);
        latestKeyData.data.interpolationIntervalId = null;
      }
      return;
    }
    await updateNowPlayingKey(serialNumber, keyManager.keyData[keyUid], false);
  }, updateInterval);
  keyManager.keyIntervals[keyId] = apiFetchIntervalId;

  if (enableInterpolation) {
    logger.info(
      `Starting UI interpolation updates for key ${keyId} every ${interpolationIntervalMs}ms.`
    );
    const interpolationIntervalId = setInterval(async () => {
      const keyExists =
        keyManager.activeKeys[keyId] && keyManager.keyData[keyUid];
      if (!keyExists) {
        logger.info(
          `Key ${keyId} no longer active/valid, clearing interpolation interval.`
        );
        clearInterval(interpolationIntervalId);
        const latestKeyData = keyManager.keyData[keyUid];
        if (
          latestKeyData?.data?.interpolationIntervalId ===
          interpolationIntervalId
        ) {
          latestKeyData.data.interpolationIntervalId = null;
        }
        return;
      }
      await renderInterpolatedNowPlaying(
        serialNumber,
        keyManager.keyData[keyUid]
      );
    }, interpolationIntervalMs);
    currentKeyData.data.interpolationIntervalId = interpolationIntervalId;
  } else {
    logger.info(`UI interpolation disabled for key ${keyId}.`);
    currentKeyData.data.interpolationIntervalId = null;
  }

  logger.info(
    `[startOrRestartNowPlayingUpdates] Key ${keyId} - Timer setup complete.`
  );
}

// Setup socket event listeners for real-time playback updates
function setupSocketEventListeners() {
  return ytmApi.setupSocketListeners((rawPlaybackState) => {
    // Mark that this update came from socket
    lastSocketStateUpdate = Date.now();
    logger.info(
      "Received raw playback state from socket:",
      JSON.stringify(rawPlaybackState)
    );

    // Transform the socket data format to match what processStateUpdate expects
    const transformedPlaybackState = {
      track: rawPlaybackState.item
        ? {
            id: rawPlaybackState.item.id,
            title: rawPlaybackState.item.name,
            author:
              rawPlaybackState.item.artists?.[0]?.name || "Unknown Artist",
            durationMs: rawPlaybackState.item.duration_ms || 0,
            albumArt: rawPlaybackState.item.album?.images?.[0]?.url || null,
          }
        : null,
      isPaused: !rawPlaybackState.is_playing,
      positionMs: rawPlaybackState.progress_ms || 0,
    };

    logger.info(
      "Transformed playback state:",
      JSON.stringify(transformedPlaybackState)
    );
    processStateUpdateWithRateLimit(transformedPlaybackState, true);
  });
}

// Rate-limited wrapper for processStateUpdate
function processStateUpdateWithRateLimit(playbackState, fromSocket = false) {
  const now = Date.now();
  const timeSinceLastProcess = now - lastProcessedTime;

  // Store the latest state update
  pendingStateUpdate = { playbackState, fromSocket, timestamp: now };

  if (timeSinceLastProcess >= STATE_UPDATE_INTERVAL_MS) {
    // Enough time has passed, process immediately
    processStateUpdateNow();
  } else {
    // Too soon, schedule for later if not already scheduled
    if (!stateUpdateTimeout) {
      const delay = STATE_UPDATE_INTERVAL_MS - timeSinceLastProcess;
      stateUpdateTimeout = setTimeout(() => {
        processStateUpdateNow();
      }, delay);
    }
    // If timeout is already scheduled, the pending update will be processed then
  }
}

// Process the pending state update immediately
function processStateUpdateNow() {
  if (stateUpdateTimeout) {
    clearTimeout(stateUpdateTimeout);
    stateUpdateTimeout = null;
  }

  if (pendingStateUpdate) {
    const { playbackState, fromSocket } = pendingStateUpdate;
    lastProcessedTime = Date.now();
    pendingStateUpdate = null;
    processStateUpdate(playbackState, fromSocket);
  }
}

// Control YTMusic Desktop playback
async function controlYTM(action, value = null) {
  return ytmApi.controlPlayback(action);
}

// Process state updates from YTMusic Desktop
function processStateUpdate(playbackState, fromSocket = false) {
  if (!playbackState) {
    logger.warn("Received null playback state");
    return;
  }

  try {
    // Add debugging to see what we're receiving
    logger.debug(
      "Raw playback state received:",
      JSON.stringify(playbackState, null, 2)
    );

    // Store previous state for comparison
    const previousTrackId = currentPlaybackState.trackId;
    const previousPlaying = currentPlaybackState.isPlaying;
    const previousProgress = currentPlaybackState.progressAtLastUpdate;
    const previousDuration = currentPlaybackState.durationMs;

    // Update current playback state
    currentPlaybackState = {
      ...currentPlaybackState,
      trackId: playbackState.track?.id || null,
      isActive: playbackState.track !== null,
      isPlaying: playbackState.isPaused === false,
      progressAtLastUpdate: playbackState.positionMs || 0,
      durationMs: playbackState.track?.durationMs || 0,
      lastApiUpdateTime: Date.now(),
    };

    const trackChanged = currentPlaybackState.trackId !== previousTrackId;
    const playStateChanged = currentPlaybackState.isPlaying !== previousPlaying;
    const durationChanged =
      currentPlaybackState.durationMs !== previousDuration;

    // Detect if a seek operation occurred
    const seekOccurred =
      currentPlaybackState.isPlaying &&
      previousPlaying &&
      currentPlaybackState.trackId === previousTrackId &&
      Math.abs(
        currentPlaybackState.progressAtLastUpdate -
          previousProgress -
          (currentPlaybackState.lastApiUpdateTime -
            currentPlaybackState.lastApiUpdateTime)
      ) > 1000;

    logger.info(
      `Updated playback state for track: ${
        playbackState.track?.title || "Unknown"
      } by ${playbackState.track?.author || "Unknown"} (Active: ${
        currentPlaybackState.isActive
      }, Playing: ${currentPlaybackState.isPlaying})`
    );

    // Update song end timer if significant changes occurred
    if (trackChanged || playStateChanged || durationChanged || seekOccurred) {
      logger.debug(
        `Setting up song end timer due to: ${
          trackChanged
            ? "track change"
            : seekOccurred
            ? "seek"
            : playStateChanged
            ? "play state change"
            : "duration change"
        }`
      );
      setupSongEndTimer(
        currentPlaybackState.progressAtLastUpdate,
        currentPlaybackState.durationMs,
        currentPlaybackState.isPlaying
      );
    }

    // Update all active YTMusic keys with new playback state
    Object.keys(keyManager.activeKeys).forEach((keyId) => {
      const [serialNumber, keyUid] = keyId.split("-");
      const key = keyManager.keyData[keyUid];

      if (key && key.cid && key.cid.includes("ytmdesktop")) {
        // Update key data with current track details
        if (!key.data) key.data = {};
        key.data.currentTrackDetails = playbackState.track;
        key.data.lastApiUpdateTime = currentPlaybackState.lastApiUpdateTime;
        key.data.progressAtLastUpdate =
          currentPlaybackState.progressAtLastUpdate;
        key.data.durationMs = currentPlaybackState.durationMs;

        if (key.cid === "com.energy.ytmdesktop.nowplaying") {
          updateNowPlayingKey(serialNumber, key);
        } else if (key.cid === "com.energy.ytmdesktop.like") {
          updateLikeKey(serialNumber, key);
        } else if (key.cid === "com.energy.ytmdesktop.control") {
          updateControlKey(serialNumber, key);
        }
      }
    });
  } catch (error) {
    logger.error("Error processing state update:", error);
  }
}

// Clear song end timer
function clearSongEndTimer() {
  if (currentPlaybackState.songEndTimerId) {
    clearTimeout(currentPlaybackState.songEndTimerId);
    currentPlaybackState.songEndTimerId = null;
  }
}

// Handle plugin alive events
async function _handlePluginAlive(payload) {
  logger.info(
    "Processing plugin.alive for YTMusic Desktop integration:",
    payload
  );
  const incomingKeys = payload.keys || [];
  const serialNumber = String(payload.serialNumber);
  const incomingKeyUids = new Set(
    incomingKeys
      .map((k) => k.uid)
      .filter((uid) => uid !== undefined && uid !== null)
  );

  logger.debug(
    `[plugin.alive] Handler received ${
      incomingKeys.length
    } keys for device ${serialNumber}. UIDs: ${Array.from(incomingKeyUids)}`
  );

  // Clean up stale keys
  const keysToCleanup = [];
  Object.keys(keyManager.activeKeys).forEach((keyId) => {
    const [sn, keyUid] = keyId.split("-");
    if (sn === serialNumber && !incomingKeyUids.has(keyUid)) {
      keysToCleanup.push({ serialNumber: sn, keyUid });
    }
  });

  if (keysToCleanup.length > 0) {
    logger.info(
      `[plugin.alive] Cleaning up ${keysToCleanup.length} stale YTMusic keys for device ${serialNumber}:`,
      keysToCleanup.map((k) => k.keyUid)
    );
    keysToCleanup.forEach(({ serialNumber: sn, keyUid }) => {
      keyManager.cleanupKey(sn, keyUid);
    });
  }

  // Track if we found any YTMusic keys
  let hasYTMusicKey = false;
  let hasNowPlayingKey = false;

  for (const key of incomingKeys) {
    const keyUid = key.uid;
    if (keyUid === undefined || keyUid === null) {
      logger.error(
        "[plugin.alive] Received key with invalid UID, skipping:",
        key
      );
      continue;
    }
    const keyId = `${serialNumber}-${keyUid}`;

    const wasAlreadyActive = keyManager.activeKeys[keyId];
    keyManager.activeKeys[keyId] = true;
    keyManager.keyData[keyUid] = key;

    // Check if this is a YTMusic integration key
    if (key.cid && key.cid.includes("ytmdesktop")) {
      hasYTMusicKey = true;

      if (key.cid === "com.energy.ytmdesktop.nowplaying") {
        hasNowPlayingKey = true;

        // If this now playing key is newly active, we need to setup the song end timer
        if (
          !wasAlreadyActive &&
          currentPlaybackState.isActive &&
          currentPlaybackState.isPlaying
        ) {
          logger.debug(
            `[plugin.alive] Setting up song end timer for new now playing key: ${keyId}`
          );
          setupSongEndTimer(
            currentPlaybackState.progressAtLastUpdate,
            currentPlaybackState.durationMs,
            currentPlaybackState.isPlaying
          );
        }
      }

      if (!wasAlreadyActive) {
        logger.info(
          `[plugin.alive] Initializing NEW YTMusic key: ${key.cid} (UID: ${keyUid}) on device ${serialNumber}`
        );
        if (key.cid === "com.energy.ytmdesktop.nowplaying") {
          await initializeNowPlayingKey(serialNumber, key);
        } else if (key.cid === "com.energy.ytmdesktop.like") {
          initializeLikeKey(serialNumber, key);
        } else if (key.cid === "com.energy.ytmdesktop.control") {
          initializeControlKey(serialNumber, key);
        }
      } else {
        logger.debug(`[plugin.alive] YTMusic key ${keyId} confirmed active.`);
      }
    }
  }

  // If no YTMusic keys exist, clear the song end timer
  if (!hasYTMusicKey || !hasNowPlayingKey) {
    clearSongEndTimer();
  }

  logger.debug(
    `[plugin.alive] Finished processing keys for device ${serialNumber}.`
  );
}

// Handle plugin data events
function _handlePluginData(payload) {
  logger.info("Received plugin.data for YTMusic Desktop integration:", payload);
  const data = payload.data;
  const serialNumber = String(payload.serialNumber);
  const key = data?.key;

  if (!key || key.uid === undefined || key.uid === null) {
    logger.error("Received plugin.data with invalid key object.", data);
    return { status: "error", message: "Invalid key data received." };
  }

  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;

  if (!keyManager.activeKeys[keyId]) {
    logger.warn(
      `Received interaction for inactive key ${keyId}. Re-registering.`
    );
    keyManager.activeKeys[keyId] = true;
    if (!keyManager.keyData[keyUid]) {
      keyManager.keyData[keyUid] = key;
      logger.warn(`Data for key ${keyUid} was missing, using received data.`);
    }
  }

  logger.info(`Received plugin.data for YTMusic key ${key.cid}.`);

  if (key.cid === "com.energy.ytmdesktop.nowplaying") {
    handleNowPlayingInteraction(serialNumber, key, data);
    return { status: "success", message: "Handled now playing interaction." };
  } else if (key.cid === "com.energy.ytmdesktop.like") {
    handleLikeInteraction(serialNumber, key, data);
    return { status: "success", message: "Handled like interaction." };
  } else if (key.cid === "com.energy.ytmdesktop.control") {
    handleControlInteraction(serialNumber, key, data);
    return { status: "success", message: "Handled control interaction." };
  }

  logger.warn(`Unhandled YTMusic key interaction for CID: ${key.cid}`);
  return { status: "ignored", message: `No handler for CID ${key.cid}` };
}

// Initialize different types of YTMusic keys
async function initializeNowPlayingKey(serialNumber, key) {
  logger.info(
    `Initializing YTMusic now playing key for device ${serialNumber}`
  );

  // Initialize key data with interpolation settings
  key.data = key.data || {};
  key.data = {
    updateInterval: key.data.updateInterval || 4000,
    interpolationIntervalMs: key.data.interpolationIntervalMs || 1000,
    enableInterpolation:
      key.data.enableInterpolation !== undefined
        ? key.data.enableInterpolation
        : true,
    showProgress:
      key.data.showProgress !== undefined ? key.data.showProgress : true,
    showTitle: key.data.showTitle !== undefined ? key.data.showTitle : true,
    showPlayPause:
      key.data.showPlayPause !== undefined ? key.data.showPlayPause : true,
    showTimeInfo:
      key.data.showTimeInfo !== undefined ? key.data.showTimeInfo : true,
    titleFontSize: key.data.titleFontSize || 18,
    artistFontSize: key.data.artistFontSize || 14,
    timeFontSize: key.data.timeFontSize || 10,
    currentTrackDetails: null,
    lastApiUpdateTime: 0,
    progressAtLastUpdate: 0,
    durationMs: 0,
    interpolationIntervalId: null,
    ...key.data,
  };

  keyManager.keyData[key.uid] = key;

  // Configure key style
  key.style = key.style || {};
  key.style.showIcon = false;
  key.style.showTitle = false;
  key.style.showEmoji = false;
  key.style.showImage = true;

  try {
    // Render loading state
    const loadingImage = await renderer.createYoutubeButtonDataUrl(
      key.width || 320,
      "Loading...",
      "Connecting...",
      false,
      "",
      0,
      0,
      key.style,
      key.data.showProgress,
      key.data.showTitle,
      key.data.showPlayPause,
      key.data.titleFontSize,
      key.data.artistFontSize,
      key.data.showTimeInfo,
      key.data.timeFontSize,
      {}
    );
    keyManager.simpleDraw(serialNumber, key, loadingImage);
  } catch (error) {
    logger.error(
      `Failed loading image for ${serialNumber}-${key.uid}: ${error.message}`
    );
    keyManager.textOnlyDraw(serialNumber, key, "Error");
  }

  await updateNowPlayingKey(serialNumber, key, true);
}

// Update specific key types with current playback state
async function updateNowPlayingKey(
  serialNumber,
  key,
  shouldStartTimers = false
) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  logger.debug(
    `[updateNowPlayingKey] Key ${keyId} - Updating state (Start timers: ${shouldStartTimers})...`
  );

  let currentKeyData = keyManager.keyData[keyUid];
  if (!currentKeyData) {
    logger.error(`Key data for ${keyUid} not found during update start.`);
    keyManager.cleanupKey(serialNumber, keyUid);
    return;
  }

  if (!keyManager.activeKeys[keyId]) {
    logger.warn(`Attempted to update inactive key ${keyId}, cleaning up.`);
    keyManager.cleanupKey(serialNumber, keyUid);
    return;
  }

  // Update key data from current playback state - use actual track details if available
  if (!currentKeyData.data) currentKeyData.data = {};

  // Don't overwrite with hardcoded values if we have real track data
  if (
    !currentKeyData.data.currentTrackDetails &&
    currentPlaybackState.trackId
  ) {
    // Only set fallback if we don't have track details but know there's a track
    currentKeyData.data.currentTrackDetails = {
      title: "Loading Track...",
      author: "Loading Artist...",
    };
  }

  currentKeyData.data.lastApiUpdateTime =
    currentPlaybackState.lastApiUpdateTime;
  currentKeyData.data.progressAtLastUpdate =
    currentPlaybackState.progressAtLastUpdate;
  currentKeyData.data.durationMs = currentPlaybackState.durationMs;

  logger.debug(
    `[updateNowPlayingKey] Track details:`,
    currentKeyData.data.currentTrackDetails
  );
  logger.debug(
    `[updateNowPlayingKey] Playback state: Active=${currentPlaybackState.isActive}, Playing=${currentPlaybackState.isPlaying}, Progress=${currentPlaybackState.progressAtLastUpdate}, Duration=${currentPlaybackState.durationMs}`
  );

  if (shouldStartTimers) {
    startOrRestartNowPlayingUpdates(serialNumber, currentKeyData);
  }

  // Render current state
  await renderInterpolatedNowPlaying(serialNumber, currentKeyData);

  logger.debug(`[updateNowPlayingKey] Key ${keyId} - Update cycle finished.`);
}

function updateLikeKey(serialNumber, key) {
  const isLiked = currentPlaybackState.isLiked || false;
  // Create appropriate like/unlike button data URL
  // const dataUrl = renderer.createLikeButtonDataUrl(isLiked);
  // keyManager.simpleDraw(serialNumber, key, dataUrl);
}

function updateControlKey(serialNumber, key) {
  const isPlaying = currentPlaybackState.isPlaying;
  // Create play/pause control button data URL
  // const dataUrl = renderer.createControlButtonDataUrl(isPlaying);
  // keyManager.simpleDraw(serialNumber, key, dataUrl);
}

// Handle interactions for different key types
async function handleNowPlayingInteraction(serialNumber, key, data) {
  logger.info("Handling now playing key interaction");

  try {
    // Toggle play/pause when now playing key is pressed
    const action = currentPlaybackState.isPlaying ? "pause" : "play";
    const success = await controlYTM(action);

    if (success) {
      logger.info(`Successfully ${action}ed music`);

      // Immediately update the UI to show the new state
      // The state will be updated properly when the next API call or socket event comes in
      currentPlaybackState.isPlaying = !currentPlaybackState.isPlaying;

      // Force an immediate re-render of the key
      await renderInterpolatedNowPlaying(serialNumber, key);

      return { status: "success", message: `Music ${action}ed` };
    } else {
      logger.error(`Failed to ${action} music`);
      return { status: "error", message: `Failed to ${action} music` };
    }
  } catch (error) {
    logger.error(`Error toggling playback: ${error.message}`);
    return { status: "error", message: `Error: ${error.message}` };
  }
}

function handleLikeInteraction(serialNumber, key, data) {
  logger.info("Handling like key interaction");
  // Toggle like status
  controlYTM(currentPlaybackState.isLiked ? "unlike" : "like");
}

function handleControlInteraction(serialNumber, key, data) {
  logger.info("Handling control key interaction");
  // Toggle play/pause
  controlYTM(currentPlaybackState.isPlaying ? "pause" : "play");
}

// --- Plugin Event Listener Setup --- //

plugin.on("ui.message", async (payload) => {
  logger.info("Received message from UI:", payload);
  // Handle YTMusic Desktop authentication
  if (payload.data === "ytm-get-auth-code") {
    try {
      const settings = payload.settings;
      logger.info(
        "Attempting to get YTMusic Desktop auth code with settings:",
        JSON.stringify(settings, null, 2)
      ); // Create connection using our API wrapper
      const connector = ytmApi.createConnection({
        host: settings.host,
        port: settings.port,
        appId: settings.appId,
        appName: settings.appName,
      });

      try {
        const authCode = await ytmApi.getAuthCode(connector);
        return { success: true, code: authCode.code };
      } catch (error) {
        logger.error("Error fetching auth code from YTMusic Desktop:", error);

        // Check for the specific AUTHORIZATION_DISABLED error
        if (error.errorCode === "AUTHORIZATION_DISABLED") {
          plugin.showSnackbarMessage(
            "error",
            error.userMessage ||
              "YTMusic Desktop has authorization requests disabled."
          );

          return {
            success: false,
            error: "Authorization disabled",
            errorCode: "AUTHORIZATION_DISABLED",
            message:
              error.userMessage ||
              "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again.",
          };
        }

        return {
          success: false,
          error: "Failed to fetch auth code",
          details: error.message,
        };
      }
    } catch (error) {
      logger.error("Error in ytm-get-auth-code handler:", error);
      return {
        success: false,
        error: "Failed to connect to YTMusic Desktop",
        details: error.message,
      };
    }
  }
  // Handle waiting for user to confirm authentication in YTMusic Desktop
  if (payload.data === "ytm-wait-for-auth") {
    try {
      const settings = payload.settings;
      logger.info(
        "Waiting for user to confirm auth in YTMusic Desktop:",
        settings
      ); // Get the active connector
      const connector = ytmApi.getActiveConnector();
      if (!connector) {
        throw new Error("No active connection found");
      }

      // Make sure we have the code in the settings and log it for debugging
      if (!settings.code) {
        logger.error("Missing required auth code in settings:", settings);
        throw new Error("Auth code is required");
      }

      logger.info("Requesting auth token with code:", settings.code);
      const authCode = settings.code; // Set timeout for the auth token request
      const timeout = settings.timeout || 15000; // Default to 15 seconds if not specified
      logger.info(`Using timeout of ${timeout}ms for auth token request`);

      // Get auth token using our API wrapper
      const tokenResponse = await ytmApi.getAuthToken(
        connector,
        authCode,
        timeout
      );

      // Set the auth token in the connector
      connector.setAuthToken(tokenResponse.token);

      logger.info("Successfully authenticated with YTMusic Desktop");

      // store it in config
      let config = plugin.getConfig();
      config.ytmToken = tokenResponse.token;
      plugin.setConfig(config);

      // Set up socket listeners for real-time updates
      setupSocketEventListeners();

      return { success: true, token: tokenResponse.token };
    } catch (error) {
      logger.error("Error during YTMusic Desktop authentication:", error);

      // Check for the specific AUTHORIZATION_DISABLED error
      if (
        error.code === "AUTHORIZATION_DISABLED" ||
        (error.statusCode === 403 &&
          error.message === "Authorization requests are disabled")
      ) {
        return {
          success: false,
          error: "Authorization disabled",
          errorCode: "AUTHORIZATION_DISABLED",
          message:
            "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again.",
        };
      }

      return { success: false, error: "Authentication failed" };
    }
  }

  // Get current YTMusic Desktop playback
  if (payload.data === "ytm-get-playback") {
    try {
      const playback = await getCurrentYTMPlayback();
      return { success: true, data: playback };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Control YTMusic Desktop playback
  if (payload.data === "ytm-control") {
    try {
      const action = payload.action;
      const success = await controlYTM(action);
      return {
        success,
        message: success
          ? `Successfully executed ${action}`
          : `Failed to execute ${action}`,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  // Handle YTMusic Desktop disconnection
  if (payload.data === "ytm-disconnect") {
    try {
      logger.info("Disconnecting from YTMusic Desktop");

      // Disconnect using our API wrapper
      ytmApi.disconnect();

      return {
        success: true,
        message: "Successfully disconnected from YTMusic Desktop",
      };
    } catch (error) {
      logger.error("Error disconnecting from YTMusic Desktop:", error);
      return {
        success: false,
        error: "Failed to disconnect from YTMusic Desktop",
      };
    }
  }

  return { success: false, error: "Unknown command" };
});

// Register this function as a listener for keyManager cleanup operations
plugin.on("device.status", (devices) => {
  const connectedSerialNumbers = devices.map((device) =>
    String(device.serialNumber)
  );

  // Check if there are any YTMusic keys still active
  let ytmusicKeysRemain = false;
  let nowPlayingKeysRemain = false;

  Object.keys(keyManager.activeKeys).forEach((keyId) => {
    const [serialNumber, keyUid] = keyId.split("-");
    if (!connectedSerialNumbers.includes(serialNumber)) {
      logger.info(
        `Device ${serialNumber} disconnected, cleaning up key ${keyUid}`
      );
      keyManager.cleanupKey(serialNumber, keyUid);
    } else {
      // Device is still connected, check if this is a YTMusic key
      const key = keyManager.keyData[keyUid];
      if (key && key.cid && key.cid.includes("ytmdesktop")) {
        ytmusicKeysRemain = true;
        if (key.cid === "com.energy.ytmdesktop.nowplaying") {
          nowPlayingKeysRemain = true;
        }
      }
    }
  });

  // If no YTMusic keys remain or no now playing keys remain, clear the song end timer
  if (!ytmusicKeysRemain || !nowPlayingKeysRemain) {
    clearSongEndTimer();
  }
});

// Handle plugin shutdown to clean up intervals
plugin.on("shutdown", () => {
  logger.info("Plugin shutting down, cleaning up intervals");
  stopConnectionCheckInterval();
  clearSongEndTimer();

  // Clean up rate limiting timeout
  if (stateUpdateTimeout) {
    clearTimeout(stateUpdateTimeout);
    stateUpdateTimeout = null;
  }

  // Clean up all key intervals and interpolation timers
  if (keyManager.keyIntervals) {
    Object.values(keyManager.keyIntervals).forEach((intervalId) => {
      clearInterval(intervalId);
    });
    keyManager.keyIntervals = {};
  }

  Object.values(keyManager.keyData).forEach((key) => {
    if (key.data && key.data.interpolationIntervalId) {
      clearInterval(key.data.interpolationIntervalId);
      key.data.interpolationIntervalId = null;
    }
  });
});

plugin.on("plugin.alive", _handlePluginAlive);
plugin.on("plugin.data", _handlePluginData);

// --- Plugin Start & Global Handlers --- //
plugin.start();
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection:", reason);
});

// Check if we have an existing token and can automatically connect
setTimeout(async () => {
  const config = plugin.getConfig();
  if (config.ytmToken) {
    try {
      logger.info(
        "Found existing YTMusic Desktop token, attempting to reconnect"
      );

      // Wait 5 seconds before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 5000));
      logger.info("Waited 5 seconds, now attempting reconnection");

      // Get the host and port from the config or use defaults
      const host = config.host || "127.0.0.1";
      const port = config.port || 9863;

      // Create a new connector using our API wrapper
      const connector = ytmApi.createConnection({
        host,
        port,
        appId: "ytmdesktop-flexbar-plugin",
        appName: "YTMDesktop FlexBar Plugin",
        appVersion: "1.0.0",
      });

      // Set the saved token
      connector.setAuthToken(config.ytmToken);

      // Set up socket listeners for real-time updates
      setupSocketEventListeners();

      logger.info("Successfully reconnected to YTMusic Desktop");
    } catch (error) {
      logger.error("Error reconnecting to YTMusic Desktop:", error);
    }
  }
}, 5000);

plugin.on("ready", async () => {
  logger.info("YTMusic Desktop integration plugin ready");
});
