// redisClient.js

const { createClient } = require("redis");

// Function to create a Redis client (supports both legacy and async modes)
function createDefaultRedisClient(isSync = false) {
    return createClient({
        url: "redis://localhost:6379", // Specify custom Redis instance URL and port
        legacyMode: isSync, // Enable legacy mode for synchronous-like operations if needed
    });
}

// Function to ensure connection to Redis
async function connectRedis(redisClient) {
    try {
        if (
            redisClient.status === "connecting" ||
            redisClient.status === "connected"
        ) {
            console.log("Redis client is already connecting or connected.");
        } else {
            await redisClient.connect();
            console.log("Redis client connected.");
        }
    } catch (error) {
        console.error("Failed to connect to Redis:", error);
        // Optionally, implement retry logic or error handling here
    }
};

async function checkRedisConnection(redisClient, isSync = false) {
    if (!redisClient) {
        redisClient = createDefaultRedisClient(isSync);
        if (!redisClient) {
            throw new Error(`Failed to create ${isSync ? 'synchronous' : 'asynchronous'} Redis client`);
        }

        if (redisClient.status !== "ready") {
            await connectRedis(redisClient); // Connect or reconnect the Redis client
        }
    }
    return redisClient;
}

function checkRedisConnectionSync(redisClientSync) {
    (async () => {
        redisClientSync = await checkRedisConnection(redisClientSync, true);
    })();

    return redisClientSync;
}


module.exports = {
    connectRedis,
    createDefaultRedisClient,
    checkRedisConnection,
    checkRedisConnectionSync
};