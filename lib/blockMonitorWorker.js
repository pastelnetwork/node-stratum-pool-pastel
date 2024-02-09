const axios = require("axios");
const fs = require("fs");
var redis = require('redis');

// Initialize Redis client
var redisClient = redis.createClient();
redisClient.on('error', function(err) {
    console.log('Redis Client Error', err);
});
redisClient.connect();

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

// Initialization and monitoring logic...
(async () => {
    try {
        await loadPastelBlockchainOperations();
        // Directly call monitorNewBlocks after successful initialization
        await monitorNewBlocks(); // This now acts as the main entry point for monitoring
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

// Function to validate a supernode signature
async function validateSupernodeSignature(
    supernodePastelIdPubKey,
    supernodeSignature,
    signedDataPayload,
    token,
) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/validate_supernode_signature`;
        const response = await axios.get(url, {
            params: {
                supernode_pastelid_pubkey: supernodePastelIdPubKey,
                supernode_pastelid_signature: supernodeSignature,
                signed_data_payload: signedDataPayload,
            },
            headers: { Authorization: token },
        });
        return response.data; // Returns a validation response indicating whether the signature is valid and the PastelID is eligible
    } catch (error) {
        console.error("Error validating supernode signature:", error);
        return null;
    }
}

async function getPreviousBlockMerkleRoot(token) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/get_previous_block_merkle_root`;
        const response = await axios.get(url, {
            headers: { Authorization: token },
        });
        return response.data; // Returns the Merkle Root as a string
    } catch (error) {
        console.error("Error getting previous block Merkle Root:", error);
        return null;
    }
}

async function refreshGlobalDictionary() {
    let localSecurityToken;
    try {
        const envContent = fs.readFileSync("/home/ubuntu/mining_block_supernode_validator/.env", "utf8");
        localSecurityToken = envContent.split("\n").find(line => line.startsWith("AUTH_TOKEN")).split("=")[1];
    } catch (error) {
        console.error("Error reading local security token:", error);
        return;
    }

    const previousBlockMerkleRoot = await getPreviousBlockMerkleRoot(localSecurityToken);

    const keys = await redisClient.keys('worker:data:*');
    for (const key of keys) {
        const workerId = key.split(':')[2];
        console.log(`Refreshing worker data for worker ID: ${workerId}`);
        const workerDataString = await redisClient.get(key);
        let workerData = JSON.parse(workerDataString);

        const signaturePack = await getSignaturePackFromRemoteMachine(workerData.remote_ip, workerData.authToken);
        if (!signaturePack) continue; // Skip if no signature pack is fetched

        if (signaturePack.previous_block_merkle_root === previousBlockMerkleRoot) {
            let signaturesArray = Object.entries(signaturePack.signatures).map(([pastelId, details]) => ({ pastelId, ...details }));
            shuffleArray(signaturesArray); // Randomize the order of signatures for fairness

            for (const { pastelId, signature } of signaturesArray) {
                const isValid = await validateSupernodeSignature(pastelId, signature, signaturePack.signedDataPayload, localSecurityToken); // Assuming validateSupernodeSignature returns a boolean
                if (isValid) {
                    workerData.can_accept_mining_workers_shares_currently = true;
                    workerData.currently_selected_supernode_pastelid_pubkey = pastelId;
                    workerData.currently_selected_supernode_signature = signature;
                    workerData.previous_block_merkle_root = previousBlockMerkleRoot;
                    break; // Assuming only one valid signature is needed to accept shares
                }
            }
        } else {
            workerData.can_accept_mining_workers_shares_currently = false;
        }

        await redisClient.set(key, JSON.stringify(workerData));
    }

    console.log("Global worker dictionary updates refreshed and saved to Redis.");
}
