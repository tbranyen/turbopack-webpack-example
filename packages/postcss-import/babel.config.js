'use strict';

module.exports = {
    presets: [
        [
            require('@babel/preset-env'),
            {
                targets: {
                    node: 'current',
                },
            },
        ],
    ],
};
