const { parentPort } = require('worker_threads');
const axios = require('axios');
const { workerData, parentPort } = require('worker_threads');
let blockchainOps;

// Load the PastelBlockchainOperations dynamically
async function loadPastelBlockchainOperations() {
    const pastelNodejsClient = await import('pastel_nodejs_client');
    blockchainOps = new pastelNodejsClient.PastelBlockchainOperations(); // Correctly instantiate the class
}

const MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT = 9997; // Ensure this matches your actual setup
const HTTP_TIMEOUT = 45000; // 45 seconds timeout

// Initialize the worker's local copy of global_worker_dict with workerData provided by the main thread
let global_worker_dict = workerData.global_worker_dict || {};

// Call loadPastelBlockchainOperations at the start of your script
loadPastelBlockchainOperations().then(() => {
    // Now PastelBlockchainOperations is loaded, and you can start monitoring blocks
    startMonitoring().catch(err => {
        console.error('Failed to start monitoring:', err);
    });
}).catch(err => {
    console.error('Failed to load PastelBlockchainOperations:', err);
});

// Utility function to shuffle an array in-place
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Swap elements
    }
}

// Function to monitor new blocks and refresh the global dictionary
async function monitorNewBlocks() {
    let currentHeight = await blockchainOps.getCurrentPastelBlockHeightAndHash();
    setInterval(async () => {
        let newHeight = await blockchainOps.getCurrentPastelBlockHeightAndHash();
        if (newHeight.bestBlockHeight > currentHeight.bestBlockHeight) {
            console.log(`New block detected at height: ${newHeight.bestBlockHeight}`);
            currentHeight = newHeight;
            await refreshGlobalDictionary();
        }
    }, 60000); // Check every minute
}

// Function to fetch the signature pack from the remote machine specified by the mining worker in their password field
async function getSignaturePackFromRemoteMachine(remoteIp, token) {
    const url = `http://${remoteIp}:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/get_block_signature_pack_from_remote_machine/${remoteIp}`;
    try {
        const response = await axios.get(url, {
            headers: { Authorization: token },
            timeout: HTTP_TIMEOUT
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching signature pack from ${remoteIp}:`, error.message);
        return null;
    }
}

// Function to validate a supernode signature
async function validateSupernodeSignature(supernodePastelIdPubKey, supernodeSignature, signedDataPayload, token) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/validate_supernode_signature`;
        const response = await axios.get(url, {
            params: {
                supernode_pastelid_pubkey: supernodePastelIdPubKey,
                supernode_pastelid_signature: supernodeSignature,
                signed_data_payload: signedDataPayload
            },
            headers: { Authorization: token }
        });
        return response.data; // Returns a validation response indicating whether the signature is valid and the PastelID is eligible
    } catch (error) {
        console.error('Error validating supernode signature:', error);
        return null;
    }
}

async function getPreviousBlockMerkleRoot(token) {
    try {
        const url = `http://localhost:${MINING_BLOCK_SUPERNODE_VALIDATOR_API_PORT}/get_previous_block_merkle_root`;
        const response = await axios.get(url, { headers: { Authorization: token } });
        return response.data; // Returns the Merkle Root as a string
    } catch (error) {
        console.error('Error getting previous block Merkle Root:', error);
        return null;
    }
}

async function refreshGlobalDictionary() {
    // First, fetch the merkle root that the pool recognizes as the current one
    const previousBlockMerkleRoot = await getPreviousBlockMerkleRoot();

    // Then, proceed to fetch signature packs from each worker and validate them
    const fetchPromises = Object.entries(global_worker_dict).map(async ([workerId, workerData]) => {
        return getSignaturePackFromRemoteMachine(workerData.remote_ip, workerData.authToken)
            .then(signaturePack => {
                // Include the workerId and whether the merkle root matches
                return {
                    workerId,
                    signaturePack,
                    merkleRootMatches: signaturePack.previous_block_merkle_root === previousBlockMerkleRoot
                };
            })
            .catch(error => {
                console.error(`Error fetching signature pack for worker ${workerId}:`, error);
                return { workerId, error: true }; // Indicate an error occurred
            });
    });

    const fetchResults = await Promise.allSettled(fetchPromises);

    fetchResults.forEach(async (result) => {
        if (result.status === 'fulfilled' && !result.value.error) {
            const { workerId, signaturePack, merkleRootMatches } = result.value;

            // Update global_worker_dict to reflect whether the merkle root matches
            if (merkleRootMatches) {
                const signaturesArray = Object.entries(signaturePack.signatures).map(([pastelId, details]) => ({
                    pastelId,
                    ...details,
                }));
                shuffleArray(signaturesArray); // Randomize the order of signatures for fairness

                const validationPromises = signaturesArray.map(({ pastelId, signature }) =>
                    validateSupernodeSignature(pastelId, signature, signaturePack.previous_block_merkle_root, global_worker_dict[workerId].authToken)
                );

                const validationResults = await Promise.allSettled(validationPromises);
                const anyValidSignature = validationResults.some(result => 
                    result.status === 'fulfilled' && result.value && result.value.is_eligible);

                global_worker_dict[workerId].can_accept_mining_workers_shares_currently = anyValidSignature;
            } else {
                // If the merkle root doesn't match, flag the worker as ineligible for share acceptance
                global_worker_dict[workerId].can_accept_mining_workers_shares_currently = false;
            }

            // Notify the main thread about the update
            parentPort.postMessage({ workerId, update: global_worker_dict[workerId] });
        } else {
            // Handle error case or invalid response
            global_worker_dict[result.value.workerId].can_accept_mining_workers_shares_currently = false;
        }
    });

    // Ensure all tasks are processed before moving on
    await Promise.allSettled(fetchResults);
}

// Function to start monitoring for new blocks
async function startMonitoring() {
    await monitorNewBlocks();
}

startMonitoring().catch(err => {
    console.error('Failed to start monitoring:', err);
});