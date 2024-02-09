const axios = require("axios");
const { createClient } = require("redis");

// Initialize Redis client with specific connection options
const redisClient = createClient({
  url: "redis://localhost:6379", // Specify custom Redis instance URL and port
});

// Function to ensure connection to Redis
async function connectRedis() {
  try {
    if (redisClient.status === "connecting" || redisClient.status === "connect") {
        console.log("Redis client is already connecting or connected.");
    } else {
        redisClient.connect().catch(console.error);
    }    
    console.log("Connected to Redis successfully.");
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
    // Optionally, implement retry logic or error handling here
  }
}

// Call connectRedis to establish the connection
connectRedis();


let blockchainOps;

// Enhanced Function to dynamically load the PastelBlockchainOperations class with retry logic
async function loadPastelBlockchainOperations(retryCount = 3) {
    let attempts = 0;
    while (attempts < retryCount) {
        try {
            // Import the named export PastelBlockchainOperations from the library
            const { PastelBlockchainOperations } = await import(
                "pastel_nodejs_client"
            );
            const ops = new PastelBlockchainOperations();
            await ops.initialize(); // Assuming an initialization method exists
            // Check directly or wait for some flag indicating it's ready
            console.log("PastelBlockchainOperations loaded and initialized");
            blockchainOps = ops; // Successfully assign to the outer scope variable
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

// Initialization and monitoring logic...
(async () => {
    try {
        await loadPastelBlockchainOperations();
        // Directly call monitorNewBlocks after successful initialization
        await monitorNewBlocks(); // This now acts as the main entry point for monitoring
        // Delay the initial call to refreshGlobalDictionary by 5 seconds (5000 milliseconds)
        await delayExecution(5000, refreshGlobalDictionary);
    } catch (error) {
        console.error("Initialization or monitoring failed:", error);
    }
})();

const MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT = 9997;
const HTTP_TIMEOUT = 45000;

// Utility function to shuffle an array in-place
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Swap elements
    }
}

// Function to monitor new blocks and refresh the global dictionary
async function monitorNewBlocks() {
    if (!blockchainOps) {
        console.error(
            "blockchainOps not initialized, cannot start monitoring.",
        );
        return;
    }

    console.log("Starting to monitor new blocks...");
    try {
        let currentHeight =
            await blockchainOps.getCurrentPastelBlockHeightAndHash();
        setInterval(async () => {
            let newHeight =
                await blockchainOps.getCurrentPastelBlockHeightAndHash();
            if (newHeight.bestBlockHeight > currentHeight.bestBlockHeight) {
                console.log(
                    `New block detected at height: ${newHeight.bestBlockHeight}`,
                );
                currentHeight = newHeight;
                await refreshGlobalDictionary();
            }
        }, 60000); // Check every minute
    } catch (error) {
        console.error("Failed to execute blockchain operation:", error);
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

async function checkIfSupernodeIsEligible(supernodePubkey){
    try{
    const eligibilityResults = await blockchainOps.getMiningEligibility(supernodePubkey)
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
        const verificationResult = await blockchainOps.verifyMessage(supernodePastelIdPubKey, supernodeSignature, signedDataPayload);
        if (verificationResult.verification === "OK") {
            console.log(
                `Supernode signature for PastelID ${supernodePastelIdPubKey} is valid.`,
            );
            return true;
        }
    } catch (error) {
        console.error("Error validating supernode signature:", error);
        return null;
    }
}

async function getBestBlockMerkleRoot() {
    try {
        const {bestBlockMerkleRoot} = await blockchainOps.getBestBlockHashAndMerkleRoot();
        return bestBlockMerkleRoot;
    } catch (error) {
        console.error("Error getting best block Merkle Root:", error);
        return null;
    }
}

async function refreshGlobalDictionary() {

    try {
        const keys = await redisClient.keys('worker:data:*');
        console.log(`Found ${keys.length} keys in the global worker dictionary! Processing...`);
        
        for (const key of keys) {
            const workerDataString = await redisClient.get(key);
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
                    const isValid = await validateSupernodeSignature(pastelId, signature, bestBlockMerkleRoot);
                    const eligibilityResults = await checkIfSupernodeIsEligible(pastelId);
                    const isEligible = eligibilityResults.eligible;
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
            await redisClient.set(key, JSON.stringify(workerData));
        }

        console.log("Global worker dictionary updates refreshed and saved to Redis.");
    } catch (error) {
        console.error("Error during global dictionary refresh:", error);
    }
}