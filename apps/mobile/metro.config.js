// Expo's defaults find the workspace root and follow pnpm's links to core.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
