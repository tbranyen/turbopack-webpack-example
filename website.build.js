const devConfig = require('./config');

exports.websiteBuild = {
  getBuildConfig: async () => {
    return {
      get(propName) {
        if (propName in devConfig) {
          return devConfig[propName];
        }

        throw new Error(`Unimplemented ${propName}`);
      },
    };
  },
};
