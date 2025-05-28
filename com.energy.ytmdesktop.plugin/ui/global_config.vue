<!-- Replace the Spotify-specific sections with YTMDesktop configuration -->
<template>
  <v-container>
    <!-- Keep the notification snackbars, just update the text -->
    <!-- ... previous snackbar code ... -->

    <!-- YTMDesktop Configuration Card -->
    <v-card elevation="2" class="mb-4 rounded-lg">
      <v-card-item
        :prepend-icon="isAuthenticated ? 'mdi-music' : 'mdi-youtube'"
        :color="isAuthenticated ? 'red' : ''"
      >
        <v-card-title>YTMusic Desktop Configuration</v-card-title>
        <v-card-subtitle>{{
          isAuthenticated
            ? "Connected to YTMusic Desktop"
            : "Configure YTMusic Desktop connection"
        }}</v-card-subtitle>
      </v-card-item>
      <v-divider></v-divider>
      <v-card-text>
        <v-alert
          v-if="authCode"
          type="info"
          density="compact"
          class="mt-3 mb-3"
        >
          Please enter the following code in the YTMusic Desktop app:
          <span class="font-weight-bold">{{ authCode }}</span>
        </v-alert>

        <v-alert
          v-if="isAuthenticated"
          type="success"
          text="Connected to YTMusic Desktop"
          density="compact"
          class="mt-3 mb-3"
        ></v-alert>

        <v-expansion-panels v-model="advancedPanelOpen" variant="accordion">
          <v-expansion-panel title="Advanced Options">
            <v-expansion-panel-text>
              <v-text-field
                v-model="modelValue.config.host"
                label="Host"
                outlined
                density="compact"
                hide-details="auto"
                class="mb-3"
                placeholder="127.0.0.1"
              ></v-text-field>

              <v-text-field
                v-model="modelValue.config.port"
                label="Port"
                outlined
                density="compact"
                hide-details="auto"
                class="mb-3"
                placeholder="9863"
                type="number"
              ></v-text-field>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
      <v-card-actions class="pa-3">
        <v-spacer></v-spacer>
        <v-btn
          v-if="!isAuthenticated"
          color="red"
          variant="flat"
          @click="startAuthFlow"
          prepend-icon="mdi-music"
        >
          Connect
        </v-btn>

        <v-btn
          v-if="isAuthenticated"
          color="error"
          variant="tonal"
          @click="disconnectYTM"
          prepend-icon="mdi-link-off"
          class="ml-2"
        >
          Disconnect
        </v-btn>
        <v-btn
          variant="tonal"
          @click="saveConfig"
          prepend-icon="mdi-content-save-outline"
          class="ml-2"
          :disabled="isInitializing"
        >
          Save
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script>
export default {
  // ... keep the props and data structure ...

  data() {
    return {
      authCode: null,
      advancedPanelOpen: null, // Closed by default
      modelValue: {
        config: {
          host: "127.0.0.1",
          port: 9863,
          isAuthenticated: false,
        },
      },
      notifications: {
        auth: {
          message: "",
          color: "",
          icon: "",
          show: false,
        },
      },
      isAuthenticated: false,
      isInitializing: true,
      // ...existing data properties...
    };
  },

  computed: {
    canAuthenticate() {
      // Always true since we use defaults
      return true;
    },
  },

  mounted() {
    this.initializeConfig();
  },

  methods: {
    async initializeConfig() {
      try {
        this.isInitializing = true;
        const config = await this.$fd.getConfig();
        console.log("Loaded config:", config);

        if (config) {
          // Set the host and port if they exist in config
          if (config.host) this.modelValue.config.host = config.host;
          if (config.port) this.modelValue.config.port = config.port;

          // Check if we have a YTMusic token
          if (config.ytmToken) {
            console.log("Found existing YTMusic token");
            this.modelValue.config.isAuthenticated = true;
            this.isAuthenticated = true;
          }
        }
      } catch (error) {
        console.error("Error loading configuration:", error);
        this.$fd.error("Failed to load configuration:", error);
      } finally {
        this.isInitializing = false;
      }
    },

    async saveConfig() {
      console.log("Saving configuration...");
      try {
        const currentConfig = await this.$fd.getConfig();
        const updatedConfig = {
          ...currentConfig,
          host: this.modelValue.config.host || "127.0.0.1",
          port: this.modelValue.config.port || 9863,
        };

        await this.$fd.setConfig(updatedConfig);

        this.notifications.auth.message = "Configuration saved successfully";
        this.notifications.auth.color = "success";
        this.notifications.auth.icon = "mdi-check-circle";
        this.notifications.auth.show = true;

        return true;
      } catch (error) {
        console.error("Error saving configuration:", error);
        this.$fd.error("Failed to save configuration:", error);
        this.showError(error);
        return false;
      }
    },

    showError(error) {
      console.error("Error:", error);
      // Placeholder implementation for showing errors
      // Replace this with actual logic to display errors to the user
    },

    async startAuthFlow() {
      console.log("Connect button clicked. Starting authentication flow...");
      this.notifications.auth.message =
        "Starting YTMusic Desktop authentication...";
      this.notifications.auth.color = "info";
      this.notifications.auth.icon = "mdi-music";
      this.notifications.auth.show = true;

      try {
        console.log("Saving configuration...");
        // Save the host/port configuration first
        await this.saveConfig();

        const settings = {
          host: this.modelValue.config.host || "127.0.0.1",
          port: this.modelValue.config.port || 9863,
          appId: "ytmdesktop-flexbar-plugin",
          appName: "YTMDesktop FlexBar Plugin",
          appVersion: "1.0.0",
        };

        console.log(
          "Requesting authentication code from backend with settings:",
          settings
        );
        // Request authentication code from the backend
        const response = await this.$fd.sendToBackend({
          data: "ytm-get-auth-code",
          settings: settings,
        });

        console.log("Response from backend:", response);

        // Check for AUTHORIZATION_DISABLED error specifically during auth code retrieval
        if (response?.errorCode === "AUTHORIZATION_DISABLED") {
          console.error(
            "Authorization disabled in YTMusic Desktop:",
            response.message
          );
          this.authCode = null;
          this.notifications.auth.message =
            response.message ||
            "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again.";
          this.notifications.auth.color = "warning";
          this.notifications.auth.icon = "mdi-alert-circle";
          this.notifications.auth.show = true;
          return;
        }

        if (response?.error) {
          throw new Error(response.error);
        }

        if (!response || !response.code) {
          console.error("Failed to retrieve authentication code:", response);
          throw new Error(
            response?.details || "Failed to retrieve authentication code"
          );
        }

        console.log("Authentication code received:", response.code);
        this.authCode = response.code;

        console.log("Waiting for user confirmation in the desktop app...");
        // Wait for user confirmation in the desktop app
        const tokenResponse = await this.$fd.sendToBackend({
          data: "ytm-wait-for-auth",
          settings: {
            ...settings,
            code: response.code, // Pass the auth code to the backend
            timeout: 60000, // Increase timeout to 60 seconds
          },
        });

        // Check for authorization disabled error
        if (tokenResponse?.errorCode === "AUTHORIZATION_DISABLED") {
          console.error(
            "Authorization disabled in YTMusic Desktop:",
            tokenResponse.message
          );
          this.authCode = null;
          this.notifications.auth.message =
            tokenResponse.message ||
            "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again.";
          this.notifications.auth.color = "warning";
          this.notifications.auth.icon = "mdi-alert-circle";
          this.notifications.auth.show = true;
          return;
        }

        if (tokenResponse?.error) {
          throw new Error(tokenResponse.error);
        }

        if (tokenResponse && tokenResponse.token) {
          console.log(
            "Authentication successful. Token received:",
            tokenResponse.token
          );

          // First update the model
          this.modelValue.config.isAuthenticated = true;

          // Update the UI state
          this.isAuthenticated = true;
          this.authCode = null;

          // Save the updated config including authenticated state
          const currentConfig = await this.$fd.getConfig();
          const updatedConfig = {
            ...currentConfig,
            isAuthenticated: true,
          };
          await this.$fd.setConfig(updatedConfig);

          this.notifications.auth.message =
            "Successfully connected to YTMusic Desktop!";
          this.notifications.auth.color = "success";
          this.notifications.auth.icon = "mdi-check-circle";
          this.notifications.auth.show = true;
        } else {
          console.error("Authentication failed.");
          throw new Error("Authentication failed");
        }
      } catch (error) {
        console.error("Error during authentication flow:", error);
        this.$fd.error("Auth error:", error);
        this.authCode = null;
        this.notifications.auth.message = error.message.includes(
          "Authorization requests are disabled"
        )
          ? "YTMusic Desktop has authorization requests disabled. Please go to YTMusic Desktop Settings → Integrations → Enable 'Companion Authorization' and try again."
          : `Authentication error: ${error.message}`;
        this.notifications.auth.color = "error";
        this.notifications.auth.icon = "mdi-alert";
        this.notifications.auth.show = true;
      }
    },

    async disconnectYTM() {
      try {
        const currentConfig = await this.$fd.getConfig();
        // Remove ytmToken from config and set isAuthenticated to false
        const updatedConfig = {
          ...currentConfig,
          ytmToken: null, // Remove the token
          isAuthenticated: false,
        };

        await this.$fd.setConfig(updatedConfig);
        this.modelValue.config.isAuthenticated = false;
        this.isAuthenticated = false;

        // Also clear the active connector in the backend
        await this.$fd.sendToBackend({
          data: "ytm-disconnect",
        });

        this.notifications.auth.message =
          "Successfully disconnected from YTMusic Desktop";
        this.notifications.auth.color = "success";
        this.notifications.auth.icon = "mdi-check-circle";
        this.notifications.auth.show = true;
      } catch (error) {
        this.$fd.error("Failed to disconnect:", error);
        this.showError(error);
      }
    },

    checkAuthStatus() {
      this.isAuthenticated = !!(
        this.modelValue.config && this.modelValue.config.isAuthenticated
      );
      this.$fd.info("Auth status checked:", this.isAuthenticated);
    },
  },
};
</script>
