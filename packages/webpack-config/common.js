const gulpUtil = require('gulp-util');
const { createHash } = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const glob = require('glob');
const webpack = require('webpack');
const { WebpackManifestPlugin } = require('webpack-manifest-plugin');
const { BundleStatsWebpackPlugin } = require('bundle-stats-webpack-plugin');
const {
    BundleAnalyzerPlugin: WebpackBundleAnalyzer,
} = require('webpack-bundle-analyzer');

// When webpack is called as `webpack serve` this invokes the dev server. By
// searching the argv we can determine if serve was used.
const isWebpackDevServer = process.argv.includes('serve');

// Webpack requires paths to start with './', so force a local path
const forceLocalPath = (assetPath) => {
    if (!assetPath) {
        return;
    }

    return assetPath[0] !== '.' && assetPath[0] !== '/'
        ? './' + assetPath
        : assetPath;
};

module.exports = (props) => {
    const { keys, values } = Object;
    const {
        NODE_ENV = 'development',
        ENTRY_TARGET,
    } = process.env;

    const isProduction = NODE_ENV === 'production';
    const appData = props.get('applicationData');
    const paths = props.get('paths');

    const { generatedRoot, srcRoot, srcCss, srcJs } = paths;
    const outputPath = path.resolve(generatedRoot, 'webpack');

    if (!process.send && !ENTRY_TARGET && require.main === module) {
        // eslint-disable-next-line no-console
        console.log('Removing files from', outputPath);

        glob.sync(path.join(outputPath, '**/*'))
            .sort()
            .reverse()
            .forEach((p) => {
                try {
                    fs.unlinkSync(p);
                } catch {
                    fs.rmdirSync(p);
                }
            });
    }

    const { entryPoints } = appData.getEntryPoints(props);

    let defaultExport = entryPoints.map((entryPoints) => {
        const [jsEntries, cssEntries] = entryPoints;
        const importOpts = {
            resolve(uri, base) {
                // This is not a regular module, search in node_modules instead.
                if (!uri.includes('/')) {
                    return require.resolve(uri);
                }
                return path.join(base, uri);
            },
            modifier: '&',
        };

        const importPlugins = [
            require('postcss-import')(importOpts),
        ];

        return {
            entry: {
                // Map each entry to the respective js and css files.
                [jsEntries[0]]: [
                    ...jsEntries.map((x) => {
                        return forceLocalPath(path.join(srcJs, x));
                    }),
                    ...cssEntries.map((x) => {
                        return forceLocalPath(path.join(srcCss, x));
                    }),
                ].filter(Boolean),
            },
            target: ['web', 'es5'],
            stats: {
                errorDetails: true,
            },
            optimization: {
                splitChunks: {
                    chunks: 'async',
                    cacheGroups: {
                        defaultVendors: {
                            // By default webpack splits node modules loaded
                            // dynamically. We do not want this behavior as it
                            // induces a separate http request and slows down mdx
                            // loading. Setting test to '' disables this chunk from
                            // occuring.
                            test: '',
                        },
                    },
                },
            },
            experiments: {
                backCompat: false,
            },
            resolve: {
                mainFields: ['browser', 'main', 'module'],
                symlinks: false,
            },
            module: {
                rules: [
                    {
                        test: /(\.less)$/i,
                        exclude: /node_modules/,
                        type: 'asset/resource',
                        use: [
                            // Once we have a single CSS file, run the autoprefixer
                            // plugin on the entire bundle.
                            {
                                loader: 'postcss-loader',
                                options: {
                                    sourceMap: false,
                                    postcssOptions: {
                                        plugins: [require('autoprefixer')],
                                    },
                                },
                            },
                            {
                                loader: 'less-loader',
                                options: {
                                    webpackImporter: false,
                                    lessOptions: {
                                        pluginManager: {},
                                    },
                                },
                            },
                            // First run postcss-loader to process LESS and
                            // combine into a single CSS file.
                            {
                                loader: 'postcss-loader',
                                options: {
                                    // Source maps currently fail due to AST
                                    // rewriting. Will revisit once Codex is
                                    // deprecated.
                                    sourceMap: false,
                                    postcssOptions: {
                                        syntax: require('postcss-less'),
                                        plugins: [
                                            require('postcss-import')(
                                                {
                                                    ...importOpts,
                                                    plugins: importPlugins,
                                                }
                                            ),
                                        ],
                                    },
                                },
                            },
                        ],
                    },
                ].filter(Boolean),
            },
            output: {
                path: outputPath,
            },
            plugins: [
                props.get('webpack.bundle.analyzer') &&
                    new WebpackBundleAnalyzer({
                        analyzerMode: 'static',
                    }),
                new webpack.DefinePlugin({
                    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
                }),
                //new WebpackManifestPlugin({
                //    fileName: path.join(
                //        path.resolve(generatedRoot, 'webpack'),
                //        jsEntries[0] + '.manifest.json'
                //    ),
                //    generate(seed, files) {
                //        const manifest = files.reduce((memo, file) => {
                //            memo[file.name] = file.path;
                //            return memo;
                //        }, seed);

                //        Object.keys(manifest).forEach((key) => {
                //            // Remove all srcCss prefixes that get
                //            // included because of webpack's misalignment with
                //            // context.
                //            const lookup = `${srcCss}/`;
                //            if (key.indexOf(lookup) === 0) {
                //                manifest[key.slice(lookup.length)] =
                //                    manifest[key];
                //                delete manifest[key];
                //            }
                //        });

                //        return manifest;
                //    },
                //}),
                props.get('webpack.bundle.stats') &&
                    new BundleStatsWebpackPlugin({
                        json: true,
                        stats: {
                            assets: true,
                            chunks: true,
                            modules: true,
                            builtAt: true,
                            hash: true,
                        },
                        // Nest stats per entry, otherwise they will be paved
                        // over.
                        outDir: './.stats/' + jsEntries[0] + '/',
                    }),
            ].filter(Boolean),
        };
    });

    /**
     * Support filtering webpack entry points by a list of fuzzy targets.
     *
     * @param {string[]} targets - list of targets to search
     * @return {object[]} - filtered targets
     */
    function filter(targets) {
        return defaultExport.filter(({ entry }) => {
            const keyName = keys(entry)[0];

            // Optimize for a single ENTRY_TARGET.
            if (keyName.includes(targets[0])) {
                return true;
            }

            // Search multiple targets to see if this build should run.
            return targets.reduce((memo, target) => {
                return (
                    memo ||
                    values(entry)[0].includes(target) ||
                    keyName.includes(target)
                );
            }, false);
        });
    }

    if (ENTRY_TARGET) {
        const targets = ENTRY_TARGET.split(',').filter(Boolean);

        if (targets.length) {
            defaultExport = filter(targets);
        }
    }

    return {
        default: defaultExport,
        filter,
    };
};
