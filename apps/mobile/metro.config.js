const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
// Allow Metro to resolve the shared workspace package from the monorepo.
config.watchFolders = [path.resolve(__dirname, '../../packages/shared')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), path.resolve(__dirname, '../../node_modules')];
module.exports = config;
