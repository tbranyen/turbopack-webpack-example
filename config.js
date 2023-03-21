const path = require('path');

module.exports = {
  'webpack.fast.refresh': true,
  'webpack.live.reload': true,
  'webpack.devserver.source.maps': 'eval',
  'webpack.cache.filesystem': false,
  'webpack.bundle.analyzer': false,
  'webpack.bundle.stats': false,
  'paths': {
    'srcRoot': path.resolve('./apps/website/src'),
    'srcCss': './apps/website/src/css',
    'srcJs': './apps/website/dist',
    'generatedRoot': path.resolve('./apps/website/dist'),
  },
  'webpack.enabled.packages': [],
  'applicationData': {
    getEntryPoints: (props) => ({
      entryPoints: [
        [
          // js
          ['index.js'],
          // less/css
          ['index.less'],
        ],
      ]
    }),
  },
};
