const { plugin } = require("@eniac/flexdesigner");
const logger = require("./loggerWrapper");
const { CompanionConnector } = require("ytmdesktop-ts-companion");

// Store active YTMusic Desktop connections
const activeConnections = {};
let activeConnector = null;

// Socket connection related state
let socketConnected = false;
let lastSocketStateUpdate = 0;

// API wrapper for YTMusic Desktop
const ytmApi = {
  /**
   * Create and setup a new YTMusic Desktop connection
   * @param {object} options Connection options
   * @param {string} options.host The YTMusic Desktop host (default: 127.0.0.1)
   * @param {number} options.port The YTMusic Desktop port (default: 9863)
   * @param {string} options.appId Application ID for the connection
   * @param {string} options.appName Application name to display in YTMusic Desktop
   * @param {string} options.appVersion Application version
   * @returns {object} The CompanionConnector instance
   */
  createConnection(options = {}) {
    const settings = {
      host: options.host || "127.0.0.1",
      port: options.port || 9863,
      appId: options.appId || "ytmdesktop-flexbar-plugin",
      appName: options.appName || "YTMDesktop FlexBar Plugin",
      appVersion: options.appVersion || "1.0.0",
    };

    logger.info("Creating YTMusic Desktop connection:", settings);

    try {
      const connector = new CompanionConnector(settings);
      activeConnections[settings.appId] = connector;
      activeConnector = connector;
      return connector;
    } catch (error) {
      logger.error("Error creating YTMusic Desktop connection:", error);
      throw error;
    }
  },

  /**
   * Get the current active connector
   * @returns {object|null} The current active connector or null if none exists
   */
  getActiveConnector() {
    return activeConnector;
  },

  /**
   * Set up socket event listeners for real-time playback updates
   * @param {function} stateUpdateCallback Callback function that will receive state updates
   * @returns {boolean} True if listeners were set up successfully
   */
  setupSocketListeners(stateUpdateCallback) {
    if (!activeConnector) {
      logger.error("Cannot setup socket listeners: No active connector");
      return false;
    }

    const socketClient = activeConnector.socketClient;

    // Clear any existing listeners first
    socketClient.removeAllStateListeners();
    socketClient.removeAllErrorListeners();
    socketClient.removeAllConnectionStateListeners();

    // Add state change listener for real-time updates
    socketClient.addStateListener((state) => {
      logger.info(
        "Received real-time state update from YTMusic Desktop",
        state.player.videoProgress
      );
      /* State object structure:
      {
  "player": {
    "trackState": 0,
    "videoProgress": 47.999999641723434,
    "volume": 0,
    "muted": false,
    "adPlaying": false,
    "queue": {
      "autoplay": false,
      "items": [
        {
          "thumbnails": [
            {
              "url": "https://lh3.googleusercontent.com/QJgYhEVpm-Tdi7aYmklyNt01i3tqrwhGsUWuwUVcUcv7-jVZlOz9i3fxiakmn08QcZNS6zJuTKQHoLTYuA=w60-h60-l90-rj",
              "width": 60,
              "height": 60
            },
            {
              "url": "https://lh3.googleusercontent.com/QJgYhEVpm-Tdi7aYmklyNt01i3tqrwhGsUWuwUVcUcv7-jVZlOz9i3fxiakmn08QcZNS6zJuTKQHoLTYuA=w120-h120-l90-rj",
              "width": 120,
              "height": 120
            },
            {
              "url": "https://lh3.googleusercontent.com/QJgYhEVpm-Tdi7aYmklyNt01i3tqrwhGsUWuwUVcUcv7-jVZlOz9i3fxiakmn08QcZNS6zJuTKQHoLTYuA=w180-h180-l90-rj",
              "width": 180,
              "height": 180
            },
            {
              "url": "https://lh3.googleusercontent.com/QJgYhEVpm-Tdi7aYmklyNt01i3tqrwhGsUWuwUVcUcv7-jVZlOz9i3fxiakmn08QcZNS6zJuTKQHoLTYuA=w226-h226-l90-rj",
              "width": 226,
              "height": 226
            },
            {
              "url": "https://lh3.googleusercontent.com/QJgYhEVpm-Tdi7aYmklyNt01i3tqrwhGsUWuwUVcUcv7-jVZlOz9i3fxiakmn08QcZNS6zJuTKQHoLTYuA=w302-h302-l90-rj",
              "width": 302,
              "height": 302
            },
            {
              "url": "https://lh3.googleusercontent.com/QJgYhEVpm-Tdi7aYmklyNt01i3tqrwhGsUWuwUVcUcv7-jVZlOz9i3fxiakmn08QcZNS6zJuTKQHoLTYuA=w544-h544-l90-rj",
              "width": 544,
              "height": 544
            }
          ],
          "title": "Run",
          "author": "OneRepublic",
          "duration": "2:50",
          "selected": false,
          "videoId": "aiMBLfDNFZE",
          "counterparts": [
            {
              "thumbnails": [
                {
                  "url": "https://i.ytimg.com/vi/TKkcsmvYTw4/sddefault.jpg?sqp=-oaymwEWCJADEOEBIAQqCghqEJQEGHgg6AJIWg&rs=AMzJL3kq172iEK4LnEPQ9FSa8Q-iXmpLnw",
                  "width": 400,
                  "height": 225
                },
                {
                  "url": "https://i.ytimg.com/vi/TKkcsmvYTw4/hq720.jpg?sqp=-oaymwEXCKAGEMIDIAQqCwjVARCqCBh4INgESFo&rs=AMzJL3mpOGBgqxkPQubdVg2IECPB4dGvLg",
                  "width": 800,
                  "height": 450
                },
                {
                  "url": "https://i.ytimg.com/vi/TKkcsmvYTw4/hq720.jpg?sqp=-oaymwEXCNUGEOADIAQqCwjVARCqCBh4INgESFo&rs=AMzJL3kddkY8nXY-hTUXa1VsmrEPwhlbDA",
                  "width": 853,
                  "height": 480
                }
              ],
              "title": "Run (Official Music Video)",
              "author": "OneRepublic",
              "duration": "2:53",
              "selected": true,
              "videoId": "TKkcsmvYTw4",
              "counterparts": null
            }
          ]
        }
      ],
      "automixItems": [],
      "isGenerating": false,
      "isInfinite": false,
      "repeatMode": 0,
      "selectedItemIndex": 9
    }
  },
  "video": {
    "author": "The Cast of Roald Dahl's Matilda The Musical",
    "channelId": "UCfVWhmeW6iuQ7ENyp_cNVfA",
    "title": "Bruce",
    "album": "Roald Dahl's Matilda The Musical (Soundtrack from the Netflix Film)",
    "albumId": "MPREb_aHCN7iCvfWu",
    "likeStatus": 1,
    "thumbnails": [
      {
        "url": "https://lh3.googleusercontent.com/n4lyztG9MdnHfHsekh5R8e_eeQK4UbXaudfdwLkLjG9bFVOdUOEuV2F2bObrbOTB3rPgXeLzhPJLQ_GQ=w60-h60-l90-rj",
        "width": 60,
        "height": 60
      },
      {
        "url": "https://lh3.googleusercontent.com/n4lyztG9MdnHfHsekh5R8e_eeQK4UbXaudfdwLkLjG9bFVOdUOEuV2F2bObrbOTB3rPgXeLzhPJLQ_GQ=w120-h120-l90-rj",
        "width": 120,
        "height": 120
      },
      {
        "url": "https://lh3.googleusercontent.com/n4lyztG9MdnHfHsekh5R8e_eeQK4UbXaudfdwLkLjG9bFVOdUOEuV2F2bObrbOTB3rPgXeLzhPJLQ_GQ=w180-h180-l90-rj",
        "width": 180,
        "height": 180
      },
      {
        "url": "https://lh3.googleusercontent.com/n4lyztG9MdnHfHsekh5R8e_eeQK4UbXaudfdwLkLjG9bFVOdUOEuV2F2bObrbOTB3rPgXeLzhPJLQ_GQ=w226-h226-l90-rj",
        "width": 226,
        "height": 226
      },
      {
        "url": "https://lh3.googleusercontent.com/n4lyztG9MdnHfHsekh5R8e_eeQK4UbXaudfdwLkLjG9bFVOdUOEuV2F2bObrbOTB3rPgXeLzhPJLQ_GQ=w302-h302-l90-rj",
        "width": 302,
        "height": 302
      },
      {
        "url": "https://lh3.googleusercontent.com/n4lyztG9MdnHfHsekh5R8e_eeQK4UbXaudfdwLkLjG9bFVOdUOEuV2F2bObrbOTB3rPgXeLzhPJLQ_GQ=w544-h544-l90-rj",
        "width": 544,
        "height": 544
      }
    ],
    "durationSeconds": 162,
    "id": "LFLxoECK4HU",
    "isLive": false,
    "videoType": 0,
    "metadataFilled": true
  },
  "playlistId": "RDTMAK5uy_nuKPeaybq-IRcrMnaR-5TIfvKxB7fVJu0"
}
      */

      // Convert the state to our expected format
      const playbackState = {
        item: {
          id: state.video?.id,
          name: state.video?.title,
          duration_ms: state.video?.durationSeconds * 1000,
          artists: [{ name: state.video?.author }],
          album: {
            images: [{ url: state.video?.thumbnails?.[0]?.url }],
          },
        },
        is_playing: state.player?.trackState === 1,
        progress_ms: state.player?.videoProgress * 1000,
      };

      // Call the state update callback
      if (typeof stateUpdateCallback === "function") {
        stateUpdateCallback(playbackState);
      }

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
        logger.info("Socket connected to YTMusic Desktop");
      }
    });

    // Connect the socket
    try {
      logger.info("Connecting socket to YTMusic Desktop");
      socketClient.connect();
      return true;
    } catch (error) {
      logger.error("Error connecting socket to YTMusic Desktop:", error);
      return false;
    }
  },

  /**
   * Disconnect from YTMusic Desktop
   */
  disconnect() {
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

    // Reset socket connection state
    socketConnected = false;
  },

  /**
   * Check if socket is connected to YTMusic Desktop
   * @returns {boolean} True if socket is connected
   */
  isSocketConnected() {
    return socketConnected;
  },

  /**
   * Request an authentication code from YTMusic Desktop
   * @param {object} connector The CompanionConnector instance
   * @returns {Promise<object>} The authentication code response
   */
  async getAuthCode(connector) {
    if (!connector) {
      if (!activeConnector) {
        throw new Error("No active YTMusic Desktop connection");
      }
      connector = activeConnector;
    }

    try {
      return await connector.restClient.getAuthCode();
    } catch (error) {
      logger.error("Error fetching auth code from YTMusic Desktop:", error);

      // Check for specific authorization disabled error
      if (
        error.code === "AUTHORIZATION_DISABLED" ||
        (error.statusCode === 403 &&
          error.message === "Authorization requests are disabled")
      ) {
        error.errorCode = "AUTHORIZATION_DISABLED";
        error.userMessage =
          "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again.";
      }

      throw error;
    }
  },

  /**
   * Get an authentication token from YTMusic Desktop
   * @param {object} connector The CompanionConnector instance
   * @param {string} authCode The authentication code from YTMusic Desktop
   * @param {number} timeout Timeout in milliseconds for the token request
   * @returns {Promise<object>} The authentication token response
   */
  async getAuthToken(connector, authCode, timeout = 15000) {
    if (!connector) {
      if (!activeConnector) {
        throw new Error("No active YTMusic Desktop connection");
      }
      connector = activeConnector;
    }

    if (!authCode) {
      throw new Error("Auth code is required");
    }

    // Create a promise that resolves with the token or rejects after timeout
    const tokenPromise = new Promise(async (resolve, reject) => {
      try {
        const tokenResponse = await connector.restClient.getAuthToken(authCode);
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
    return await Promise.race([tokenPromise, timeoutPromise]);
  },

  /**
   * Get current YTMusic Desktop playback state
   * @returns {Promise<object|null>} The current playback state or null if not available
   */
  async getCurrentPlayback() {
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
  },

  /**
   * Control YTMusic Desktop playback
   * @param {string} action The action to perform (play, pause, next, previous)
   * @returns {Promise<boolean>} True if the action was successful
   */
  async controlPlayback(action) {
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
  },

  /**
   * Check if tracks are saved in the user's library
   * @param {string[]} trackIds Array of track IDs to check
   * @returns {Promise<boolean[]>} Array of booleans indicating if each track is saved
   */
  async checkTracksSaved(trackIds) {
    try {
      if (!activeConnector) {
        logger.error("No active YTMusic Desktop connection");
        return [];
      }

      if (!trackIds || trackIds.length === 0) {
        return [];
      }

      return await activeConnector.restClient.checkTracksSaved(trackIds);
    } catch (error) {
      logger.error("Error checking if tracks are saved:", error);
      return [];
    }
  },

  /**
   * Save tracks to the user's library
   * @param {string[]} trackIds Array of track IDs to save
   * @returns {Promise<boolean>} True if the operation was successful
   */
  async saveTracks(trackIds) {
    try {
      if (!activeConnector) {
        logger.error("No active YTMusic Desktop connection");
        return false;
      }

      if (!trackIds || trackIds.length === 0) {
        return false;
      }

      await activeConnector.restClient.saveTracks(trackIds);
      return true;
    } catch (error) {
      logger.error("Error saving tracks:", error);
      return false;
    }
  },

  /**
   * Remove tracks from the user's library
   * @param {string[]} trackIds Array of track IDs to remove
   * @returns {Promise<boolean>} True if the operation was successful
   */
  async removeTracks(trackIds) {
    try {
      if (!activeConnector) {
        logger.error("No active YTMusic Desktop connection");
        return false;
      }

      if (!trackIds || trackIds.length === 0) {
        return false;
      }

      await activeConnector.restClient.removeTracks(trackIds);
      return true;
    } catch (error) {
      logger.error("Error removing tracks:", error);
      return false;
    }
  },
};

// Export the API
module.exports = ytmApi;
