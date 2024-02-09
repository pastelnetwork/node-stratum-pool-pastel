var net = require('net');
var events = require('events');
var { Worker } = require('worker_threads');
var path = require('path');
var redis = require('redis');

// Initialize Redis client
var redisClient = redis.createClient({
    // Redis connection options, if any (e.g., host, port, password)
});
redisClient.on('error', function(err) {
    console.log('Redis Client Error', err);
});

async function startBlockMonitoringWorker() {
    await redisClient.connect();

    const lockKey = 'blockMonitorWorker:lock';
    // Use async/await for Redis operations
    const lockValue = await redisClient.get(lockKey);
    if (lockValue) {
        console.log('Block monitor worker already running in another process.');
        return;
    }

    try {
        // Use SET command directly to utilize NX and EX options atomically
        const setResult = await redisClient.set(lockKey, 'true', {
            EX: 60, // Expire the lock after 60 seconds
            NX: true // Set only if the key does not exist
        });

        if (setResult !== 'OK') {
            console.log('Block monitor worker already running in another process.');
            return;
        }

        const workerPath = path.resolve(__dirname, './blockMonitorWorker.js');
        const worker = new Worker(workerPath);

        worker.on('error', console.error);
        worker.on('exit', async (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
            // Remove the lock when the worker exits
            await redisClient.del(lockKey);
        });

        console.log('Block monitor worker started.');
    } catch (error) {
        console.error('Error starting block monitor worker:', error);
    }
}

exports.createPool = function (poolOptions, authorizeFn) {
    var newPool = new pool(poolOptions, authorizeFn);
    return newPool;
};

// Start the block monitoring worker
startBlockMonitoringWorker();
