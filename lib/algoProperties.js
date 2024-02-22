var util = require('./util.js');
const { is_validSolution } = require('equihash-node-binding'); // Adjusted to use the new library

//var diff1 = global.diff1 = 0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

var diff1 = global.diff1 = 0x07ffff0000000000000000000000000000000000000000000000000000000000;

var algos = module.exports = global.algos = {
    sha256: {
        //Uncomment diff if you want to use hardcoded truncated diff
        //diff: '00000000ffff0000000000000000000000000000000000000000000000000000',
        hash: function(){
            return function(){
                return util.sha256d.apply(this, arguments);
            }
        }
    },
    'equihash': {
        multiplier: 1,
        // diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        diff: parseInt('0x07ffff0000000000000000000000000000000000000000000000000000000000'),
        hash: function(coinOptions) {
            let parameters = coinOptions.parameters;
            if (!parameters) {
                parameters = {
                    n: 200,
                    k: 9
                }
            }

            let n = parameters.n || 200;
            let k = parameters.k || 9;
            // The new library handles the personalization internally, so we don't need to worry about it here.

            return function(header, solution) {
                // Convert the header and solution to hex strings if they are not already.
                let headerHex = header.toString('hex');
                let solutionHex = solution.toString('hex');

                // Call the new verification function.
                let isValid = is_validSolution(n, k, headerHex, solutionHex);

                return isValid;
            }
        }
    }
};

for (var algo in algos){
    if (!algos[algo].multiplier)
        algos[algo].multiplier = 1;
}
