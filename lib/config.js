// config.js

let g_poolConfigs = {};

function setPoolConfigs(newPoolConfigs) {
    g_poolConfigs = newPoolConfigs;
}

function getPoolConfigs() {
    return g_poolConfigs;
}

module.exports = {
    setPoolConfigs,
    getPoolConfigs
};