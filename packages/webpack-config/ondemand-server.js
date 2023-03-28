const gutil = require('gulp-util');
const path = require('path');

let httpServer;
let webpackDevServer;

// To be used for determining if an entry point has been previously used.
// const webpackEntryPoints = new Set();
exports.webpackEntryPoints = webpackEntryPoints;

/**
 * Creates a new Webpack On Demand Server which intercepts asset connections
 * and spins up an appropriate webpack-dev-server to monitor, rebuild and
 * refresh the page.
 *
 * @param {object} options - Required arguments
 * @param options.props - Configuration
 * @param options.port - Port to start the on demand server on
 * @param options.entryTargets - Allow warming a webpack-dev-server process
 * @param options.devServerPort - What port to bind webpack-dev-server to
 * @param options.pino - Use this for logging purposes
 * @param options.cwd - The working directory for the app
 */
exports.create = ({
    props,
    port,
    entryTargets,
    devServerPort,
    pino,
    cwd,
}) => {
    const http = require('http');
    const waitPort = require('wait-port');
    const paths = props.get('paths');

    const reset = () => {
        // If there is an existing on-demand server, close before creating a
        // new one.
        if (httpServer) {
            httpServer.close();
        }

        // Ensure known entry points are cleared after a reload.
        webpackEntryPoints.clear();

        // Ensure the dev server is terminated when reset.
        webpackDevServer && webpackDevServer.kill();

        // No longer used
        webpackDevServer = undefined;
    };

    // Reset the environment whenever create is called.
    reset();

    // Prime a webpack-dev-server process at startup to get faster cold boot
    // times.
    if (entryTargets && entryTargets.length) {
        spawnWebpackForEntry(entryTargets, devServerPort, pino, cwd);
    }

    // Forward the request to the webpack-dev-server port.
    const proxyRequest = (url, res) => {
        gutil.log(`Making request to http://localhost:${devServerPort}${url}`);
        return require('request')(`http://localhost:${devServerPort}${url}`)
            .on('error', (err) => {
                gutil.log(err);
                res.statusCode = 404;
                res.end();
            })
            .pipe(res);
    };

    // Create an HTTP server to intercept local assets and automatically spin
    // up a development server to build them.
    httpServer = http.createServer(async (req, res) => {
        const { dir, name } = path.parse(req.url.split('?')[0]);
        // Extension-less.
        const asset = `/${dir}/${name}`.slice(paths.publicPath.length + 1);

        if (asset.endsWith('.hot-update')) {
            return proxyRequest(req.url, res);
        }

        // Look up the root entry point
        const rootEntryPoint = findRootEntryForAsset(props, asset);

        // If we cannot determine what root entry point an asset corresponds to
        // then try and redirect it to the currently running server as it is
        // most likely a dynamic import.
        if (!rootEntryPoint) {
            gutil.log(
                `Unable to find entry point match for '${asset}'; will try active webpack-dev-server`
            );

            // Set a timeout since no server may be running.
            await waitPort({ port: devServerPort, timeout: 1000 });

            return proxyRequest(req.url, res);
        }

        // Create or reuse a webpack-dev-server process for the given entry point.
        const { reused } = await spawnWebpackForEntry(
            [rootEntryPoint],
            devServerPort,
            pino,
            cwd
        );

        // Give one second for server to be ready to accept connections
        if (!reused) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        try {
            await waitPort({ port: devServerPort });
            gutil.log(
                `Found entry point '${rootEntryPoint}' for asset ${asset}`
            );

            proxyRequest(req.url, res);
        } catch (e) {
            gutil.log(gutil.colors.red(e));
        }
    });

    httpServer.on('error', (e) => {
        console.error(e);
    });

    httpServer.listen(port);

    // Public API
    return {
        getDevServer() {
            return webpackDevServer;
        },
        reset() {
            return reset();
        },
    };
};

/**
 * Locates a webpack entry target from an asset name being requested. This
 * works by looking at the transpiled input entry points and matching them
 * to the requested file names.
 *
 * @param {*} props - Configuration
 * @param {string} asset - Asset to lookup in conductors to get entry asset
 * @returns undefined | string
 */
function findRootEntryForAsset(props, asset) {
    const appMetaData = props.get('applicationData');
    const { entryPoints } = appMetaData.getEntryPoints();

    let rootEntry;

    entryPoints.forEach((entryPoints) => {
        if (rootEntry) {
            return;
        }

        const [jsEntries, cssEntries] = entryPoints;

        // Has JS match
        let hasMatch = false;

        jsEntries.forEach((jsEntry) => {
            if (!hasMatch && jsEntry === asset) {
                hasMatch = true;
            }
        });

        cssEntries.forEach((cssEntry) => {
            const { dir, name } = path.parse(cssEntry);
            const basename = `${dir}/${name}`;
            // rtl files are a byproduct of the original css file, so remove
            // the suffix in the file.
            const hasRTL = asset.slice(-4) === '.rtl';
            const assetWithoutRTL = hasRTL ? asset.slice(0, -4) : asset;

            // For fakira strip the src/less prefix from the route for matching.
            if (assetWithoutRTL.indexOf('src/less/') === 0) {
                assetWithoutRTL = assetWithoutRTL.slice('src/less/'.length);
            }

            // Check if the css file matches the asset.
            if (!hasMatch && basename === assetWithoutRTL) {
                hasMatch = true;
            }
        });

        if (hasMatch) {
            // Always use the first JS asset as the root entry.
            rootEntry = jsEntries[0];
        }
    });

    return rootEntry;
}

/**
 * Spawns a new webpack-dev-server for the given entry targets. Will
 * reuse the existing process if it already matches the assets being
 * requested.
 *
 * New entry targets are unified with the existing targets under a
 * single process. This is to simplify issues with websockets and
 * to reduce complexity.
 *
 * @param {string[]} entryTargets
 * @param {number} devServerPort
 * @param {object} pino
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function spawnWebpackForEntry(entryTargets, devServerPort, pino, cwd) {
    const childProcess = require('child_process');

    // Determine if we have new targets incoming to spin up a new server or if
    // we can simply reuse the existing server.
    const hasNewTargets = entryTargets.some(
        (target) => !webpackEntryPoints.has(target)
    );

    if (!hasNewTargets) {
        return { reused: true };
    }

    // Start tracking new entry targets.
    entryTargets.forEach((target) => webpackEntryPoints.add(target));

    // A unified array of entry points containing all assets that have been
    // requested during the development session.
    const unifiedEntryPoints = Array.from(webpackEntryPoints);

    gutil.log(
        'Spawning webpack for targets',
        Array.from(unifiedEntryPoints),
        'in directory',
        cwd
    );

    // Wait for existing dev server to exit before launching new one.
    if (webpackDevServer) {
        webpackDevServer.kill();
    }

    // Start a server with all assets tracked.
    webpackDevServer = childProcess.spawn(
        'node',
        [
            path.join(require.resolve('webpack'), '../../../.bin', 'webpack'),
            'serve',
            '--port',
            String(devServerPort),
        ],
        {
            stdio: ['pipe', pino.stdin, process.stderr],
            env: {
                ...process.env,
                ENTRY_TARGET: Array.from(webpackEntryPoints).join(','),
            },
            cwd,
        }
    );
    return { reused: false };
}
