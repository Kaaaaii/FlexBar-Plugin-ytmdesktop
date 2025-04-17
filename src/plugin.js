const { plugin, pluginPath, resourcesPath } = require("@eniac/flexdesigner");
const logger = require("./loggerWrapper");
const path = require("path");
const open = require("open");
const { escapeXml } = require("./utils");
const renderer = require("./canvasRenderer");
const keyManager = require("./keyManager");
const { CompanionConnector } = require("ytmdesktop-ts-companion");

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

// Store active YTMusic Desktop connections
const activeConnections = {};
let activeConnector = null;

// Socket connection related state
let socketConnected = false;
let lastSocketStateUpdate = 0;

// Get current YTMusic Desktop playback state
async function getCurrentYTMPlayback() {
  try {
    if (!activeConnector) {
      logger.error("No active YTMusic Desktop connection");
      return null;
    }

    const state = await activeConnector.socketClient.getState();
    if (!state) {
      return null;
    }

    return {
      item: {
        id: state.trackInfo?.videoId,
        name: state.trackInfo?.title,
        duration_ms: state.trackInfo?.duration * 1000,
        artists: [{ name: state.trackInfo?.author }],
        album: {
          images: [{ url: state.trackInfo?.cover }],
        },
      },
      is_playing: state.player?.isPaused === false,
      progress_ms: state.player?.seekbarCurrentPosition * 1000,
    };
  } catch (error) {
    logger.error("Error getting YTMusic Desktop playback:", error);
    return null;
  }
}

// Setup socket event listeners for real-time playback updates
function setupSocketEventListeners() {
  if (!activeConnector) {
    logger.error("Cannot setup socket listeners: No active connector");
    return;
  }

  const socketClient = activeConnector.socketClient;

  // Clear any existing listeners first
  socketClient.removeAllStateListeners();
  socketClient.removeAllErrorListeners();
  socketClient.removeAllConnectionStateListeners();

  // Add state change listener for real-time updates
  socketClient.addStateListener((state) => {
    logger.info("Received real-time state update from YTMusic Desktop");

    // Convert the state to our expected format
    const playbackState = {
      item: {
        id: state.trackInfo?.videoId,
        name: state.trackInfo?.title,
        duration_ms: state.trackInfo?.duration * 1000,
        artists: [{ name: state.trackInfo?.author }],
        album: {
          images: [{ url: state.trackInfo?.cover }],
        },
      },
      is_playing: state.player?.isPaused === false,
      progress_ms: state.player?.seekbarCurrentPosition * 1000,
    };

    // Process the state update
    processStateUpdate(playbackState);

    // Update the last update time
    lastSocketStateUpdate = Date.now();
  });

  // Add error listener
  socketClient.addErrorListener((error) => {
    logger.error("Socket error from YTMusic Desktop:", error);
    socketConnected = false;
  });

  // Add connection state listener
  socketClient.addConnectionStateListener((state) => {
    logger.info("Socket connection state changed:", state);
    socketConnected = state === "connected";

    if (socketConnected) {
      logger.info(
        "Socket connected to YTMusic Desktop, requesting initial state"
      );
      // Request an initial state
      socketClient
        .getState()
        .then((state) => {
          if (state) {
            logger.info("Received initial state after socket connection");
            const playbackState = {
              item: {
                id: state.trackInfo?.videoId,
                name: state.trackInfo?.title,
                duration_ms: state.trackInfo?.duration * 1000,
                artists: [{ name: state.trackInfo?.author }],
                album: {
                  images: [{ url: state.trackInfo?.cover }],
                },
              },
              is_playing: state.player?.isPaused === false,
              progress_ms: state.player?.seekbarCurrentPosition * 1000,
            };
            processStateUpdate(playbackState);
          }
        })
        .catch((error) => {
          logger.error(
            "Error getting initial state after socket connection:",
            error
          );
        });
    }
  });

  // Connect the socket
  try {
    logger.info("Connecting socket to YTMusic Desktop");
    socketClient.connect();
  } catch (error) {
    logger.error("Error connecting socket to YTMusic Desktop:", error);
  }
}

// Process a state update from polling or socket events
function processStateUpdate(playbackState) {
  const now = Date.now();
  const isActive = !!(playbackState && playbackState.item);
  const isPlaying = isActive && playbackState.is_playing;
  const currentTrack = isActive ? playbackState.item : null;
  const trackId = currentTrack?.id;
  const progressMs = isActive ? playbackState.progress_ms : 0;
  const durationMs = currentTrack?.duration_ms || 0;

  // Store previous state for comparison
  let previousTrackId = currentPlaybackState.trackId;
  let previousProgress = currentPlaybackState.progressAtLastUpdate;
  let previousDuration = currentPlaybackState.durationMs;
  let previousPlaying = currentPlaybackState.isPlaying;

  // Update state
  currentPlaybackState.isActive = isActive;
  currentPlaybackState.isPlaying = isPlaying;
  currentPlaybackState.trackId = trackId;
  currentPlaybackState.progressAtLastUpdate = progressMs;
  currentPlaybackState.lastApiUpdateTime = now;
  currentPlaybackState.durationMs = durationMs;

  let trackChanged = false;
  let likedStatusChanged = false;
  let seekOccurred = false;

  // Detect if a seek operation occurred
  if (
    isPlaying &&
    previousPlaying &&
    trackId === previousTrackId &&
    Math.abs(
      progressMs -
        previousProgress -
        (now - currentPlaybackState.lastApiUpdateTime)
    ) > 1000
  ) {
    seekOccurred = true;
    logger.info(
      `Seek detected: Progress jumped from ${previousProgress}ms to ${progressMs}ms`
    );
  }

  if (trackId !== previousTrackId) {
    trackChanged = true;
    logger.info(`Track changed: ${trackId} (was ${previousTrackId})`);
    currentPlaybackState.isLiked = null;

    if (
      isActive &&
      trackId &&
      trackId !== currentPlaybackState.lastCheckedTrackId
    ) {
      logger.debug(`Checking liked status for new track: ${trackId}`);
      // Fetch liked status (async, will be updated later)
      activeConnector.restClient
        .checkTracksSaved([trackId])
        .then((savedStatus) => {
          if (savedStatus && savedStatus.length > 0) {
            currentPlaybackState.isLiked = savedStatus[0];

            // Update any like keys
            Object.keys(keyManager.activeKeys).forEach((activeKeyId) => {
              const [sn, likeKeyUid] = activeKeyId.split("-");
              const likeKey = keyManager.keyData[likeKeyUid];
              if (
                likeKey &&
                likeKey.cid === "com.energy.spotify_integration.like"
              ) {
                likeKey.data = likeKey.data || {};
                likeKey.data.currentTrackId = currentPlaybackState.trackId;
                likeKey.data.isLiked = currentPlaybackState.isLiked;
                logger.debug(
                  `Updating like key ${activeKeyId} display after liked status fetch - Track: ${likeKey.data.currentTrackId}, Liked: ${likeKey.data.isLiked}`
                );
                updateLikeKeyDisplay(sn, likeKey);
              }
            });
          } else {
            logger.warn(
              `Could not determine liked status for track ${trackId}`
            );
            currentPlaybackState.isLiked = null;
          }
          currentPlaybackState.lastCheckedTrackId = trackId;
        })
        .catch((error) => {
          logger.error(
            `Error checking if track ${trackId} is saved: ${error.message}`
          );
          currentPlaybackState.isLiked = null;
        });
    } else if (!isActive) {
      logger.info("Playback stopped or became inactive.");
      currentPlaybackState.isLiked = null;
      currentPlaybackState.lastCheckedTrackId = null;
    }
  }

  // Update song end timer if needed
  if (
    trackChanged ||
    likedStatusChanged ||
    seekOccurred ||
    isPlaying !== previousPlaying ||
    durationMs !== previousDuration
  ) {
    logger.debug(
      `Setting up song end timer due to: ${
        trackChanged
          ? "track change"
          : seekOccurred
          ? "seek"
          : "play state change"
      }`
    );
    setupSongEndTimer(progressMs, durationMs, isPlaying);
  }

  // Update all relevant now playing keys
  Object.keys(keyManager.activeKeys).forEach((keyId) => {
    const [serialNumber, keyUid] = keyId.split("-");
    const key = keyManager.keyData[keyUid];
    if (key && key.cid === "com.energy.spotify_integration.nowplaying") {
      const currentKeyData = keyManager.keyData[keyUid];
      if (currentKeyData && currentKeyData.data) {
        currentKeyData.data.currentTrackDetails = currentTrack;
        currentKeyData.data.lastApiUpdateTime = now;
        currentKeyData.data.progressAtLastUpdate = progressMs;
        currentKeyData.data.durationMs = durationMs;

        // Render the updated state
        renderInterpolatedNowPlaying(serialNumber, currentKeyData);
      }
    }
  });

  // Update like keys if track changed
  if (trackChanged) {
    logger.debug(`Track changed, updating relevant like keys.`);
    Object.keys(keyManager.activeKeys).forEach((activeKeyId) => {
      const [sn, likeKeyUid] = activeKeyId.split("-");
      const likeKey = keyManager.keyData[likeKeyUid];
      if (likeKey && likeKey.cid === "com.energy.spotify_integration.like") {
        likeKey.data = likeKey.data || {};
        likeKey.data.currentTrackId = currentPlaybackState.trackId;
        likeKey.data.isLiked = currentPlaybackState.isLiked;
        logger.debug(
          `Updating like key ${activeKeyId} display - Track: ${likeKey.data.currentTrackId}, Liked: ${likeKey.data.isLiked}`
        );
        updateLikeKeyDisplay(sn, likeKey);
      }
    });
  }
}

// Control YTMusic Desktop playback
async function controlYTM(action, value = null) {
  try {
    if (!activeConnector) {
      logger.error("No active YTMusic Desktop connection for control action");
      return false;
    }

    switch (action) {
      case "play":
        await activeConnector.restClient.play();
        break;
      case "pause":
        await activeConnector.restClient.pause();
        break;
      case "next":
        await activeConnector.restClient.next();
        break;
      case "previous":
        await activeConnector.restClient.previous();
        break;
      default:
        logger.warn(`Unsupported YTMusic Desktop control action: ${action}`);
        return false;
    }

    return true;
  } catch (error) {
    logger.error(`Error controlling YTMusic Desktop (${action}):`, error);
    return false;
  }
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
      );

      const connector = new CompanionConnector({
        host: settings.host,
        port: settings.port,
        appId: settings.appId,
        appName: settings.appName,
        appVersion: "1.0.0",
      });
      activeConnections[settings.appId] = connector;
      activeConnector = connector;

      try {
        const authCode = await connector.restClient.getAuthCode();
        return { success: true, code: authCode.code };
      } catch (error) {
        logger.error("Error fetching auth code from YTMusic Desktop:", error);

        // Check for the specific AUTHORIZATION_DISABLED error
        if (
          error.code === "AUTHORIZATION_DISABLED" ||
          (error.statusCode === 403 &&
            error.message === "Authorization requests are disabled")
        ) {
          plugin.showSnackbarMessage(
            "error",
            "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again."
          );

          return {
            success: false,
            error: "Authorization disabled",
            errorCode: "AUTHORIZATION_DISABLED",
            message:
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
      );

      const connector = activeConnections[settings.appId];
      if (!connector) {
        throw new Error("No active connection found for appId");
      }

      // Make sure we have the code in the settings and log it for debugging
      if (!settings.code) {
        logger.error("Missing required auth code in settings:", settings);
        throw new Error("Auth code is required");
      }

      logger.info("Requesting auth token with code:", settings.code);
      const authCode = settings.code;

      // Set timeout for the auth token request
      const timeout = settings.timeout || 15000; // Default to 15 seconds if not specified
      logger.info(`Using timeout of ${timeout}ms for auth token request`);

      // Create a promise that resolves with the token or rejects after timeout
      const tokenPromise = new Promise(async (resolve, reject) => {
        try {
          const tokenResponse = await connector.restClient.getAuthToken(
            authCode
          );
          resolve(tokenResponse);
        } catch (error) {
          reject(error);
        }
      });

      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("Authentication request timed out")),
          timeout
        );
      });

      // Race the token request against the timeout
      const tokenResponse = await Promise.race([tokenPromise, timeoutPromise]);

      connector.setAuthToken(tokenResponse.token);

      logger.info("Successfully authenticated with YTMusic Desktop");
      // store it
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

      // Clean up socket listeners
      if (activeConnector) {
        try {
          activeConnector.socketClient.removeAllStateListeners();
          activeConnector.socketClient.removeAllErrorListeners();
          activeConnector.socketClient.removeAllConnectionStateListeners();
        } catch (socketError) {
          logger.warn("Error cleaning up socket listeners:", socketError);
        }
        activeConnector = null;
      }

      // Clear all active connections
      Object.keys(activeConnections).forEach((appId) => {
        delete activeConnections[appId];
      });

      // Reset playback state
      currentPlaybackState = {
        trackId: null,
        isLiked: null,
        lastCheckedTrackId: null,
        isActive: false,
        isPlaying: false,
        progressAtLastUpdate: 0,
        lastApiUpdateTime: 0,
        durationMs: 0,
        songEndTimerId: null,
      };

      // Reset socket connection state
      socketConnected = false;

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
  // If no devices are connected, clear the song end timer
  if (!devices || devices.length === 0) {
    clearSongEndTimer();
  }
});

plugin.on("device.status", _handleDeviceStatus);
plugin.on("plugin.alive", _handlePluginAlive);
plugin.on("plugin.data", _handlePluginData);

// --- Refactored Event Handler Logic (Update to use keyManager) --- //

function _handleDeviceStatus(devices) {
  logger.info("Device status changed (handler):", devices);
  const connectedSerialNumbers = devices.map((device) =>
    String(device.serialNumber)
  );

  // Check if there are any now playing keys still active
  let nowPlayingKeysRemain = false;

  Object.keys(keyManager.activeKeys).forEach((keyId) => {
    const [serialNumber, keyUid] = keyId.split("-");
    if (!connectedSerialNumbers.includes(serialNumber)) {
      logger.info(
        `Device ${serialNumber} disconnected, cleaning up key ${keyUid} via handler`
      );
      keyManager.cleanupKey(serialNumber, keyUid);
    } else {
      // Device is still connected, check if this is a now playing key
      const key = keyManager.keyData[keyUid];
      if (key && key.cid === "com.energy.spotify_integration.nowplaying") {
        nowPlayingKeysRemain = true;
      }
    }
  });

  // If no now playing keys remain, clear the song end timer
  if (!nowPlayingKeysRemain) {
    clearSongEndTimer();
  }
}

function _handlePluginAlive(payload) {
  logger.info("Processing plugin.alive (handler):", payload);
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

  const keysToCleanup = [];
  Object.keys(keyManager.activeKeys).forEach((keyId) => {
    const [sn, keyUid] = keyId.split("-");
    if (sn === serialNumber && !incomingKeyUids.has(keyUid)) {
      keysToCleanup.push({ serialNumber: sn, keyUid });
    }
  });

  if (keysToCleanup.length > 0) {
    logger.info(
      `[plugin.alive] Cleaning up ${keysToCleanup.length} stale keys for device ${serialNumber}:`,
      keysToCleanup.map((k) => k.keyUid)
    );
    keysToCleanup.forEach(({ serialNumber: sn, keyUid }) => {
      keyManager.cleanupKey(sn, keyUid);
    });
  } else {
    logger.debug(
      `[plugin.alive] No stale keys to clean up for device ${serialNumber}.`
    );
  }

  // Track if we found any now playing keys
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

    if (key.cid === "com.energy.spotify_integration.nowplaying") {
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
        `[plugin.alive] Initializing NEW key: ${key.cid} (UID: ${keyUid}) on device ${serialNumber}`
      );
      if (key.cid === "com.energy.spotify_integration.nowplaying") {
        initializeNowPlayingKey(serialNumber, key);
      } else if (key.cid === "com.energy.spotify_integration.counter") {
        initializeCounterKey(serialNumber, key);
      } else if (key.cid === "com.energy.spotify_integration.like") {
        initializeLikeKey(serialNumber, key);
      }
    } else {
      logger.debug(`[plugin.alive] Key ${keyId} confirmed active.`);
    }
  }

  // If no now playing keys exist, clear the song end timer
  if (!hasNowPlayingKey) {
    clearSongEndTimer();
  }

  logger.debug(
    `[plugin.alive] Finished processing keys for device ${serialNumber}.`
  );
}

function _handlePluginData(payload) {
  logger.info("Received plugin.data (handler):", payload);
  const data = payload.data;
  const serialNumber = String(payload.serialNumber);
  const key = data?.key;

  if (!key || key.uid === undefined || key.uid === null) {
    logger.error(
      "Received plugin.data with invalid key object (handler).",
      data
    );
    return { status: "error", message: "Invalid key data received." };
  }

  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;

  if (!keyManager.activeKeys[keyId]) {
    logger.warn(
      `Received interaction for inactive key ${keyId} (handler). Re-registering.`
    );
    keyManager.activeKeys[keyId] = true;
    if (!keyManager.keyData[keyUid]) {
      keyManager.keyData[keyUid] = key;
      logger.warn(
        `Data for key ${keyUid} was missing, using received data (handler).`
      );
    }
  }
  logger.info(`Received plugin.data for key ${key} (handler).`);

  if (key.cid === "com.energy.spotify_integration.nowplaying") {
    handleNowPlayingInteraction(serialNumber, key, data);
    return { status: "success", message: "Handled now playing interaction." };
  } else if (key.cid === "com.energy.spotify_integration.like") {
    handleLikeInteraction(serialNumber, key, data);
    return { status: "success", message: "Handled like interaction." };
  }

  logger.warn(`Unhandled key interaction via handler for CID: ${key.cid}`);
  return { status: "ignored", message: `No handler for CID ${key.cid}` };
}

/**
 * Setup or update the song end timer for automatic playback refresh
 * @param {number} progressMs Current playback position in ms
 * @param {number} durationMs Total song duration in ms
 * @param {boolean} isPlaying Whether playback is currently active
 */
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

  // Set the timeout to call getCurrentPlayback when the song should end
  currentPlaybackState.songEndTimerId = setTimeout(async () => {
    logger.info("Song end timer triggered - requesting current playback state");
    try {
      // Instead of immediately fetching, let's check if we got a socket update recently
      const now = Date.now();
      const timeSinceLastSocketUpdate = now - lastSocketStateUpdate;

      // If we had a recent socket update, we can skip the fetch
      if (socketConnected && timeSinceLastSocketUpdate < 2000) {
        logger.info(
          "Skipping fetch after song end - recent socket update available"
        );
      } else {
        const playbackState = await getCurrentYTMPlayback();
        logger.debug("Successfully fetched playback after song end");

        if (playbackState) {
          // Process the state update
          processStateUpdate(playbackState);
        }
      }
    } catch (error) {
      logger.error(`Error fetching playback after song end: ${error.message}`);
    }
    currentPlaybackState.songEndTimerId = null;
  }, remainingMs);
}

// --- Initialization and Interaction Handlers (Update to use keyManager) --- //

/** Renders the Now Playing key using interpolated progress */
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
    showProgress,
    showTitle,
    showPlayPause,
    showTimeInfo,
    titleFontSize,
    artistFontSize,
    timeFontSize,
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
    const imageUrl = currentTrackDetails?.album?.images?.[0]?.url;
    const title = escapeXml(
      currentTrackDetails?.name || (isActive ? "Loading..." : "Nothing Playing")
    );
    const artist = escapeXml(
      currentTrackDetails?.artists?.map((a) => a.name).join(", ") || ""
    );

    const buttonDataUrl = await renderer.createSpotifyButtonDataUrl(
      currentKeyData.width || 360,
      title,
      artist,
      isPlaying,
      imageUrl,
      Math.round(estimatedProgress),
      durationMs,
      currentKeyData.style || {},
      showProgress,
      showTitle,
      showPlayPause,
      titleFontSize,
      artistFontSize,
      showTimeInfo,
      timeFontSize,
      {}
    );
    keyManager.simpleDraw(serialNumber, currentKeyData, buttonDataUrl);
  } catch (error) {
    try {
      keyManager.textOnlyDraw(serialNumber, currentKeyData, "Render Error");
    } catch (fallbackError) {
      logger.error(
        `[renderInterpolated] Key ${keyId} - FAILED to draw fallback text: ${fallbackError.message}`
      );
    }
  }
}

/** Initialize Now Playing Key */
async function initializeNowPlayingKey(serialNumber, key) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  logger.info("Initializing nowplaying key:", keyId);

  key.data = key.data || {};
  const progressBarColor = key.data.progressBarColor || "#1ED760";

  key.data = {
    interpolationIntervalMs: key.data.interpolationIntervalMs || 1000,
    enableInterpolation:
      key.data.enableInterpolation !== undefined
        ? key.data.enableInterpolation
        : true,
    showArtist: key.data.showArtist !== undefined ? key.data.showArtist : true,
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
    progressBarColor: progressBarColor,
    currentTrackDetails: null,
    lastApiUpdateTime: 0,
    progressAtLastUpdate: 0,
    durationMs: 0,
    interpolationIntervalId: null,
  };

  keyManager.keyData[keyUid] = key;

  key.style = key.style || {};
  key.style.showIcon = false;
  key.style.showTitle = false;
  key.style.showEmoji = false;
  key.style.showImage = true;
  key.style.progressBarColor = key.data.progressBarColor;

  try {
    const renderStyle = {
      ...key.style,
      progressBarColor: key.data.progressBarColor,
    };

    const loadingImage = await renderer.createSpotifyButtonDataUrl(
      key.width || 360,
      "Loading...",
      "Connecting...",
      false,
      null,
      0,
      0,
      renderStyle,
      key.data.showProgress,
      key.data.showTitle,
      key.data.showPlayPause,
      key.data.titleFontSize,
      key.data.artistFontSize,
      key.data.showTimeInfo,
      key.data.timeFontSize
    );
    keyManager.simpleDraw(serialNumber, key, loadingImage);
  } catch (error) {
    logger.error(`Failed loading image for ${keyId}: ${error.message}`);
    keyManager.textOnlyDraw(serialNumber, key, "Error");
  }

  // Only start interpolation timer, no API fetch timer
  startInterpolationTimer(serialNumber, key);

  // Request an initial state if socket is connected
  if (socketConnected && activeConnector) {
    try {
      const state = await activeConnector.socketClient.getState();
      if (state) {
        const playbackState = {
          item: {
            id: state.trackInfo?.videoId,
            name: state.trackInfo?.title,
            duration_ms: state.trackInfo?.duration * 1000,
            artists: [{ name: state.trackInfo?.author }],
            album: {
              images: [{ url: state.trackInfo?.cover }],
            },
          },
          is_playing: state.player?.isPaused === false,
          progress_ms: state.player?.seekbarCurrentPosition * 1000,
        };
        processStateUpdate(playbackState);
      }
    } catch (error) {
      logger.error(`Error getting initial state for key ${keyId}:`, error);
    }
  }
}

// Add a new function to only start interpolation (no API fetch timer)
/** Start UI interpolation timer only */
function startInterpolationTimer(serialNumber, key) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  const currentKeyData = keyManager.keyData[keyUid];

  if (!currentKeyData || !currentKeyData.data) {
    logger.error(`Cannot start interpolation for ${keyId}, key data missing.`);
    return;
  }

  const { interpolationIntervalMs, enableInterpolation } = currentKeyData.data;

  // Clear existing interpolation timer if it exists
  if (currentKeyData.data.interpolationIntervalId) {
    logger.debug(`Clearing existing interpolation timer for ${keyId}`);
    clearInterval(currentKeyData.data.interpolationIntervalId);
    currentKeyData.data.interpolationIntervalId = null;
  }

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

  logger.info(`[startInterpolationTimer] Key ${keyId} - Timer setup complete.`);
}

/** Initialize Like Key */
async function initializeLikeKey(serialNumber, key) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  logger.info("Initializing like key:", keyId);

  key.data = {
    likedColor: key.data?.likedColor || "#1ED760",
    unlikedColor: key.data?.unlikedColor || "#FFFFFF",
    likeBgColor: key.data?.likeBgColor || "#424242",
    isLiked: currentPlaybackState.isLiked,
    currentTrackId: currentPlaybackState.trackId,
  };
  keyManager.keyData[keyUid] = key;
  keyManager.activeKeys[keyId] = true;

  updateLikeKeyDisplay(serialNumber, key);
}

/** Update Like Key Display */
async function updateLikeKeyDisplay(serialNumber, key) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  logger.debug(`Updating like key display: ${keyId}`);

  if (!keyManager.activeKeys[keyId]) {
    logger.warn(`Attempted to update inactive like key ${keyId}.`);
    return;
  }

  const currentKeyData = keyManager.keyData[keyUid];
  if (!currentKeyData || !currentKeyData.data) {
    logger.error(
      `Key data or key.data missing for like key ${keyUid} during display update.`
    );
    return;
  }

  const { isLiked, likedColor, unlikedColor, likeBgColor } =
    currentKeyData.data;

  try {
    const buttonDataUrl = await renderer.createSpotifyButtonDataUrl(
      currentKeyData.width || 80,
      null,
      null,
      null,
      null,
      0,
      0,
      currentKeyData.style || {},
      false,
      false,
      false,
      0,
      0,
      false,
      0,
      {
        buttonType: "like",
        isLiked: isLiked,
        likedColor: likedColor,
        unlikedColor: unlikedColor,
        likeBgColor: likeBgColor,
      }
    );
    keyManager.simpleDraw(serialNumber, currentKeyData, buttonDataUrl);
  } catch (error) {
    logger.error(`Error rendering like key ${keyId}: ${error.message}`);
    const errorText = isLiked === null ? "?" : isLiked ? "♥" : "♡";
    keyManager.textOnlyDraw(serialNumber, currentKeyData, errorText);
  }
}

/** Handle Interaction for Like Key */
async function handleLikeInteraction(serialNumber, key, data) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;
  logger.info(`Handling like interaction for key ${keyId}`);

  const currentKeyData = keyManager.keyData[keyUid];
  if (!currentKeyData || !currentKeyData.data) {
    logger.error(
      `Key data or key.data missing for like key ${keyUid} during interaction.`
    );
    return;
  }

  const { currentTrackId, isLiked } = currentKeyData.data;

  if (!currentTrackId) {
    logger.warn(
      `Like button pressed (${keyId}) but no current track ID is known.`
    );
    return;
  }

  if (isLiked === null) {
    logger.warn(`Like button pressed (${keyId}) but liked status is unknown.`);
    return;
  }

  try {
    if (isLiked) {
      logger.info(
        `Attempting to remove track ${currentTrackId} from library (key: ${keyId})`
      );
      await activeConnector.restClient.removeTracks([currentTrackId]);
      logger.info(`Successfully removed track ${currentTrackId}`);
      currentKeyData.data.isLiked = false;
      currentPlaybackState.isLiked = false;
    } else {
      logger.info(
        `Attempting to add track ${currentTrackId} to library (key: ${keyId})`
      );
      await activeConnector.restClient.saveTracks([currentTrackId]);
      logger.info(`Successfully saved track ${currentTrackId}`);
      currentKeyData.data.isLiked = true;
      currentPlaybackState.isLiked = true;
    }

    await updateLikeKeyDisplay(serialNumber, currentKeyData);
  } catch (error) {
    logger.error(
      `Failed to ${isLiked ? "remove" : "save"} track ${currentTrackId}: ${
        error.message
      }`
    );
  }
}

/** Initialize Counter Key */
function initializeCounterKey(serialNumber, key) {
  const keyUid = key.uid;
  keyManager.keyData[keyUid] = key;
  keyManager.keyData[keyUid].counter = parseInt(key.data?.rangeMin || "0");
  key.style = key.style || {};
  key.style.showIcon = false;
  key.style.showTitle = true;
  key.title = "Click Me!";
  keyManager.simpleTextDraw(serialNumber, key);
}

/** Handle Interaction for Now Playing Key */
async function handleNowPlayingInteraction(serialNumber, key, data) {
  const keyUid = key.uid;
  const keyId = `${serialNumber}-${keyUid}`;

  if (!keyManager.keyData[keyUid]) keyManager.keyData[keyUid] = {};
  Object.assign(keyManager.keyData[keyUid], key);
  const currentKeyData = keyManager.keyData[keyUid];

  currentKeyData.style = currentKeyData.style || {};
  currentKeyData.style.showIcon = false;
  currentKeyData.style.showTitle = false;
  currentKeyData.style.showEmoji = false;
  currentKeyData.style.showImage = true;

  if (data.evt === "click") {
    try {
      if (!activeConnector) {
        logger.error(
          `Cannot toggle play/pause for ${keyId}: No active connector`
        );
        return;
      }

      const playbackState = await getCurrentYTMPlayback();
      const isCurrentlyPlaying = playbackState?.is_playing || false;
      await controlYTM(isCurrentlyPlaying ? "pause" : "play");

      // Short delay to let the state update
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Update the key (no need to restart timers)
      await updateNowPlayingKey(serialNumber, currentKeyData, false);
    } catch (error) {
      logger.error(`Error handling play/pause click for ${keyId}:`, error);
    }
  } else {
    await updateNowPlayingKey(serialNumber, currentKeyData);
  }
}

/**
 * Reset and clear the song end timer if it exists
 */
function clearSongEndTimer() {
  if (currentPlaybackState.songEndTimerId) {
    logger.debug("Clearing song end timer during cleanup");
    clearTimeout(currentPlaybackState.songEndTimerId);
    currentPlaybackState.songEndTimerId = null;
  }
}

// --- Plugin Start & Global Handlers --- //
plugin.start();
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection:", reason);
});
plugin.on("ready", async () => {
  logger.info("YTMusic Desktop integration plugin ready");

  // Check if we have an existing token and can automatically connect
  const config = plugin.getConfig();
  if (config.ytmToken) {
    try {
      logger.info(
        "Found existing YTMusic Desktop token, attempting to reconnect"
      );

      // Get the host and port from the config or use defaults
      const host = config.host || "127.0.0.1";
      const port = config.port || 9863;

      // Create a new connector
      const connector = new CompanionConnector({
        host,
        port,
        appId: "ytmdesktop-flexbar-plugin",
        appName: "YTMDesktop FlexBar Plugin",
        appVersion: "1.0.0",
      });

      // Set the saved token
      connector.setAuthToken(config.ytmToken);

      // Store the connector
      activeConnections["ytmdesktop-flexbar-plugin"] = connector;
      activeConnector = connector;

      // Set up socket listeners for real-time updates
      setupSocketEventListeners();

      logger.info("Successfully reconnected to YTMusic Desktop");
    } catch (error) {
      logger.error("Error reconnecting to YTMusic Desktop:", error);
    }
  }
});
