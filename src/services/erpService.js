const axios = require("axios");
const { decryptSecret } = require("./erpCredentialService");

class ErpService {
  static createClient(erpConfig, extraHeaders = {}, timeoutOverride = null) {
    const config = {
      baseURL: erpConfig.baseUrl,
      timeout: timeoutOverride || 120000,
      headers: {
        Accept: "application/json",
        ...extraHeaders,
      },
    };

    if (erpConfig.authType === "BASIC") {
      config.auth = {
        username: erpConfig.username,
        password: decryptSecret(erpConfig.password),
      };
    }

    if (erpConfig.authType === "BEARER") {
      config.headers.Authorization = `Bearer ${decryptSecret(erpConfig.apiKey)}`;
    }

    if (erpConfig.authType === "API_KEY") {
      config.headers["x-api-key"] = decryptSecret(erpConfig.apiKey);
    }

    return axios.create(config);
  }
}

module.exports = ErpService;