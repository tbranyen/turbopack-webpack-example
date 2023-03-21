module.exports = async () => {
    const { websiteBuild } = require('./website.build');
    const props = await websiteBuild.getBuildConfig();

    if (process.env.NODE_ENV === 'production') {
        return require('webpack-config/prod')(props);
    }

    return require('webpack-config/dev')(props);
};
