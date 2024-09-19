// blockMonitorWorker.js

const axios = require("axios");
const Worker = require("worker_threads");

const Redis = require("./redisClient.js");
const { hash } = require("crypto");

let g_blockchainOps;
let g_redisClient = null;

// Enhanced Function to dynamically load the PastelBlockchainOperations class with retry logic
async function loadPastelBlockchainOperations(retryCount = 3, coinDaemonDirectory = null) {
    if (!g_redisClient) {
        g_redisClient = await Redis.checkRedisConnection(g_redisClient);
    }

    let attempts = 0;
    while (attempts < retryCount) {
        try {
            // Import the named export PastelBlockchainOperations from the library
            const module = await import("pastel_nodejs_client");
            const PastelBlockchainOperations = module.PastelBlockchainOperations;

            const ops = new PastelBlockchainOperations(coinDaemonDirectory);
            await ops.initialize(); // Assuming an initialization method exists
            // Check directly or wait for some flag indicating it's ready
            console.log("PastelBlockchainOperations loaded and initialized");
            g_blockchainOps = ops; // Successfully assign to the outer scope variable
            return; // Exit after successful initialization
        } catch (error) {
            console.error(
                `Attempt ${attempts + 1}: Error loading PastelBlockchainOperations`,
                error,
            );
            attempts++;
            if (attempts >= retryCount) {
                throw new Error(
                    "Failed to load PastelBlockchainOperations after several attempts",
                );
            }
        }
    }
}

// Function to delay execution of a given function by a specified time
function delayExecution(delayMs, functionToExecute) {
    return new Promise((resolve) => {
        setTimeout(async () => {
            await functionToExecute();
            resolve();
        }, delayMs);
    });
}

const MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT = 9997;
const HTTP_TIMEOUT = 45000;

// Utility function to shuffle an array in-place
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Swap elements
    }
}

// Function to reset worker states upon detecting a new block
async function resetWorkerStates() {
    if (!g_redisClient) {
        g_redisClient = await Redis.checkRedisConnection(g_redisClient);
    }

    const keys = await g_redisClient.keys('worker:data:*');
    console.log(`Resetting states for ${keys.length} workers.`);
    for (const key of keys) {
        const workerDataString = await g_redisClient.get(key);
        if (!workerDataString) {
            console.log(`No data found for key ${key}, skipping.`);
            continue;
        }

        let workerData = JSON.parse(workerDataString);
        // Set flag to false to prevent accepting shares until validated
        workerData.can_accept_mining_workers_shares_currently = false;
        await g_redisClient.set(key, JSON.stringify(workerData));
    }
}

// Function to fetch the signature pack from the remote machine specified by the mining worker in their password field
async function getSignaturePackFromRemoteMachine(remoteIp, token) {
    const url = `http://${remoteIp}:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/get_block_signature_pack_from_remote_machine/${remoteIp}`;
    try {
        const response = await axios.get(url, {
            headers: { Authorization: token },
            timeout: HTTP_TIMEOUT,
        });
        return response.data;
    } catch (error) {
        console.error(
            `Error fetching signature pack from ${remoteIp}:`,
            error.message,
        );
        return null;
    }
}

async function checkIfSupernodeIsEligible(supernodePubkey) {
    try {
        const eligibilityResults = await g_blockchainOps.getMiningEligibility(supernodePubkey)
        return eligibilityResults
    } catch (error) {
        console.error("Error fetching mining eligibility:", error);
        return null;
    }
}

// Function to validate a supernode signature
async function validateSupernodeSignature(
    supernodePastelIdPubKey,
    supernodeSignature,
    signedDataPayload,
) {
    try {
        const verificationResult = await g_blockchainOps.verifyBase64MessageWithPastelid(supernodePastelIdPubKey, signedDataPayload, supernodeSignature);
        // Explicitly check for the "OK" verification result
        if (verificationResult === "OK") {
            console.log(`Supernode signature for PastelID ${supernodePastelIdPubKey} is valid.`);
            return true; // Valid signature
        } else {
            console.log(`Supernode signature for PastelID ${supernodePastelIdPubKey} is invalid.`);
            return false; // Invalid signature
        }
    } catch (error) {
        console.error("Error validating supernode signature:", error);
        return null; // Error occurred
    }
}

async function getBestBlockMerkleRoot() {
    try {
        const { bestBlockMerkleRoot } = await g_blockchainOps.getBestBlockHashAndMerkleRoot();
        return bestBlockMerkleRoot;
    } catch (error) {
        console.error("Error getting best block Merkle Root:", error);
        return null;
    }
}

function getEligibilityByPastelId(eligibilityResults, pastelId) {
    const node = eligibilityResults.nodes.find(node => node.mnid === pastelId);
    if (node) {
        return node.eligible;
    } else {
        console.error(`Node with PastelID ${pastelId} not found.`);
        return null; // or any other value indicating that the node wasn't found
    }
}

async function refreshGlobalDictionary() {
    try {
        if (!g_redisClient) {
            g_redisClient = await Redis.checkRedisConnection(g_redisClient);
        }

        const keys = await g_redisClient.keys('worker:data:*');
        console.log(`Found ${keys.length} keys in the global worker dictionary! Processing...`);
        shuffleArray(keys);

        for (const key of keys) {
            const workerDataString = await g_redisClient.get(key);
            if (!workerDataString) {
                console.log(`No data found for key ${key}, skipping.`);
                continue;
            }

            let workerData = JSON.parse(workerDataString);

            console.log(`Refreshing worker data for worker with data: ${workerDataString}`);

            const signaturePack = await getSignaturePackFromRemoteMachine(workerData.remote_ip, workerData.authToken);
            if (!signaturePack) {
                console.log(`No signature pack found for worker ${workerData.remote_ip}, skipping.`);
                continue; // Skip if no signature pack is fetched
            }

            const bestBlockMerkleRoot = await getBestBlockMerkleRoot();
            if (signaturePack.best_block_merkle_root === bestBlockMerkleRoot) {
                console.log(`Signature pack for worker ${workerData.remote_ip} is up-to-date and matches the best block Merkle Root determined by the mining pool.`);
                let signaturesArray = Object.entries(signaturePack.signatures).map(([pastelId, details]) => ({ pastelId, ...details }));
                console.log(`Found ${signaturesArray.length} signatures for worker ${workerData.remote_ip}; shuffling these and then validating them.`);
                shuffleArray(signaturesArray); // Randomize the order of signatures for fairness
                let validSignatureFound = false;
                for (const { pastelId, signature } of signaturesArray) {
                    console.log(`PastelID: ${pastelId}, Signature: ${signature}, Best Block Merkle Root: ${bestBlockMerkleRoot}`)
                    const bestBlockMerkleRootInvertedBase64 = Buffer.from(signaturePack.best_block_merkle_root, 'hex').reverse().toString('base64');
                    const isValid = await validateSupernodeSignature(pastelId, signature, bestBlockMerkleRootInvertedBase64);
                    const eligibilityResults = await checkIfSupernodeIsEligible(pastelId);
                    const isEligible = getEligibilityByPastelId(eligibilityResults, pastelId);
                    if (isValid && isEligible) {
                        console.log(`Valid signature found for currently eligible worker ${workerData.remote_ip} from supernode with PastelID ${pastelId}.`);
                        workerData.can_accept_mining_workers_shares_currently = true;
                        workerData.currently_selected_supernode_pastelid_pubkey = pastelId;
                        workerData.currently_selected_supernode_signature = signature;
                        workerData.best_block_merkle_root = bestBlockMerkleRoot;
                        workerData.last_updated_timestamp = Date.now();
                        validSignatureFound = true;
                        break; // Exit the loop once a valid signature is found
                    }
                }
                if (!validSignatureFound) {
                    console.log(`No valid signatures found for worker ${workerData.remote_ip}.`);
                    workerData.can_accept_mining_workers_shares_currently = false;
                }
            } else {
                console.log(`Signature pack for worker ${workerData.remote_ip} is outdated or does not match the best block Merkle Root determined by the mining pool.`);
                workerData.can_accept_mining_workers_shares_currently = false;
            }
            console.log(`Updated worker data for worker with data: ${JSON.stringify(workerData)}`);
            await g_redisClient.set(key, JSON.stringify(workerData));
        }

        console.log("Global worker dictionary updates refreshed and saved to Redis.");
    } catch (error) {
        console.error("Error during global dictionary refresh:", error);
    }
}

// Handle new block detected
async function handleNewBlockDetected() {
    // Reset worker states before refreshing the global dictionary                
    await resetWorkerStates();

    // Force an immediate update of the global dictionary with mnids and signatures
    await refreshGlobalDictionary();
}

// Flag to indicate if the check for a new block is in progress
let g_isNewBlockCheckInProgress = false;
// store the latest block height and hash
let g_currentBlock = null;

// Function to check for a new block
async function checkForNewBlock() {
    if (g_isNewBlockCheckInProgress)
        return;

    g_isNewBlockCheckInProgress = true;
    try {

        const newBlock = await g_blockchainOps.getCurrentPastelBlockHeightAndHash();
        if (!g_currentBlock || newBlock.bestBlockHeight > g_currentBlock.bestBlockHeight) {
            console.log(`New block detected ${newBlock.bestBlockHash} at height: ${newBlock.bestBlockHeight}`);
            g_currentBlock = newBlock;
            await handleNewBlockDetected();
        }
    } catch (error) {
        console.error("Failed to check for new block:", error);
    } finally {
        g_isNewBlockCheckInProgress = false;
    }
}

// Function to monitor new blocks and refresh the global dictionary
async function monitorNewBlocks() {
    if (!g_blockchainOps) {
        console.error(
            "g_blockchainOps not initialized, cannot start monitoring.",
        );
        return;
    }
    console.log(`Starting to monitor new blocks (thread id: ${Worker.threadId})...`);

    // delay the first check for 5 seconds
    delayExecution(5000, async () => {
        await checkForNewBlock();
    });
    setInterval(async () => {
        await checkForNewBlock();
    }, 60000); // Check every minute
}

async function initialize() {
    await loadPastelBlockchainOperations(3, Worker.workerData ? Worker.workerData.coinDaemonDirectory : null);
    // Directly call monitorNewBlocks after successful initialization
    await monitorNewBlocks(); // This now acts as the main entry point for monitoring
}

// Check if the workerType is 'pool', otherwise skip initialization
if (process.env.workerType === 'pool') {
    console.log("Initializing block monitor for PoolWorker...");

    // Initialization and monitoring logic...
    (async () => {
        try {
            await initialize();
        } catch (error) {
            console.error("Block monitor initialization failed:", error);
        }
    })();
}

module.exports = {
    checkForNewBlock
};
