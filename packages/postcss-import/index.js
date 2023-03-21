'use strict';

const { join, dirname } = require('path');
const { readFile } = require('fs').promises;

const isImportNode = (node) => {
    return node.type === 'atrule' && node.import;
};

// Try removing a node safely, catching and doing nothing if it fails.
const safeRemove = (node) => {
    try {
        node.remove();
    } catch {
        /* do nothing */
    }
};

// Ensure all imports are scrubbed from the output.
const removeAllImports = (rootNode) =>
    [...rootNode.nodes].forEach((node) => {
        if (isImportNode(node)) {
            const i = rootNode.nodes.indexOf(node);
            rootNode.nodes.splice(i, 1);

            // When removing an import, ensure the next rule that takes
            // its place has a newline before it, otherwise you risk
            // joining the rule with a comment.
            if (rootNode.nodes[i]) {
                rootNode.nodes[i].raws.before = '\n';
            }
        } else if (node.nodes) {
            removeAllImports(node);
        }
    });

function ImportPlugin(options = {}) {
    if (!options.resolve) {
        options.resolve = (uri, base) => join(base, uri);
    }

    return {
        postcssPlugin: 'postcss-import',

        async OnceExit(rootStyles, { result, postcss }) {
            const { syntax, from } = result.opts;
            const imports = result.opts.imports || new Map();
            const orderedImports = result.opts.orderedImports || [];
            const isRoot = !('nested' in result.opts);

            // List of dependencies which are imported from non-inclusion
            // rules, and should not be prefixed. Any imports that are only
            // imported by inclusion rules should be prefixed.

            // Discover all imports recursively.
            const findImports = async (styles, fromPath) =>
                styles.nodes.reduce(async (promise, styleNode) => {
                    await promise;

                    if (isImportNode(styleNode)) {
                        const { fromInclusionRule } = styleNode;
                        const filename = styleNode.filename.replace(/'|"/g, '');
                        const fullpath = options.resolve(
                            filename,
                            dirname(fromPath)
                        );

                        // Disallow duplicate inserts, remove import node if
                        // found.
                        if (imports.has(fullpath)) {
                            const importOpts = imports.get(fullpath);

                            // If there are no inclusion rules, mark this import
                            // as global.
                            if (!fromInclusionRule) {
                                importOpts.isGloballyImported = true;
                            }
                            // If there is an inclusion rule associated with
                            // the import, make sure it is added to the list of
                            // selectors to prefix.
                            else {
                                importOpts.inclusionRules.add(
                                    fromInclusionRule
                                );
                            }

                            return promise;
                        }

                        const contents = await readFile(fullpath, {
                            encoding: 'utf8',
                        });

                        // Skip common dependencies (reference > 1) when parsing
                        const { root } = await postcss(
                            options.plugins || []
                        ).process(contents, {
                            from: fullpath,
                            // Proxy shared variables across modules, these
                            // will show up as `result.opts` as seen above.
                            syntax,
                            imports,
                            orderedImports,
                            nested: true,
                        });

                        const importOpts = {
                            root,
                            styleNode,
                            fullpath,
                            fromPath,

                            // Determine if this module has been globally
                            // imported. This will allow skipping prefixing.
                            isGloballyImported: !fromInclusionRule,

                            // Associate inclusion rules. If there was none,
                            // filter out the initial value creating an empty
                            // set for future updates while crawling deps.
                            inclusionRules: new Set(
                                [fromInclusionRule].filter(Boolean)
                            ),
                        };

                        // Set import data, maintaining order using an array.
                        // The imports object is treated as a way to easily
                        // access an entry and shortcircuit when already
                        // processed.
                        imports.set(fullpath, importOpts);
                        orderedImports.push(importOpts);

                        // Find nested imports.
                        await findImports(root, fullpath);
                    } else if (styleNode.nodes) {
                        await findImports(styleNode, fromPath);
                    }

                    return Promise.resolve();
                }, Promise.resolve());

            // Start off recursive search for all imports.
            await findImports(rootStyles, from);

            // Only do final processing if in the root entry point. Otherwise
            // we will scrub imports and do processing too early before knowing
            // the full state of the LESS.
            if (!isRoot) {
                return;
            }

            const sharedDependencies = [];

            // Merge imports with contents.
            orderedImports.forEach(
                (
                    {
                        root,
                        inclusionRules,
                        isGloballyImported,
                        styleNode,
                        fullpath,
                        fromPath,
                    },
                    i
                ) => {
                    let parentNodes = styleNode.parent.nodes;
                    let index = parentNodes.indexOf(styleNode);

                    // Ensure that all dependencies are tracked in the webpack
                    // postcss-loader plugin.
                    result.messages.push({
                        type: 'dependency',
                        file: fullpath,
                    });

                    // Attempt to find index by crawling through nested nodes due
                    // to rule wrapping.
                    if (index === -1) {
                        const recursiveLook = (nodes) => {
                            if (index > -1) {
                                return;
                            }

                            nodes.forEach((node) => {
                                if (index > -1) {
                                    return;
                                }

                                if (node.nodes) {
                                    index = node.nodes.indexOf(styleNode);

                                    if (index === -1 && node.nodes) {
                                        recursiveLook(node.nodes);
                                    } else {
                                        parentNodes = node.nodes;
                                    }
                                }
                            });
                        };

                        recursiveLook(parentNodes);
                    }

                    const prevNode = parentNodes[index - 1];

                    // When injecting new nodes, ensure there is a line break present
                    // otherwise you may see unstable behavior with single line comments.
                    if (root.nodes[0]) {
                        root.nodes[0].raws.before = '\n\n';
                    }

                    // Inject the nodes for the import globally if needed everywhere.
                    if (isGloballyImported) {
                        sharedDependencies.push(...root.nodes);
                    }
                    // Otherwise scope the imports to the respective inclusion
                    // rules. We must first find the import location within the
                    // prefixed rule. That way we can ensure proper placement of
                    // the import.
                    else {
                        // Look up an inclusion selector in the root nodes.
                        function findSelector(selector) {
                            let foundRule = null;

                            // First check if the root node contains the inclusion
                            // rule.
                            rootStyles.nodes.forEach((node) => {
                                const lookup = node.selector;

                                if (
                                    lookup === `${selector}` ||
                                    lookup === `${options.modifier}${selector}`
                                ) {
                                    foundRule = node;
                                }
                            });

                            if (foundRule) {
                                return foundRule;
                            }

                            // Otherwise, the root selector will usually be the
                            // next in the ordered imports, but not always, so
                            // search through all imports to find it.
                            orderedImports.forEach((r) => {
                                if (
                                    r.root &&
                                    r.root.nodes &&
                                    r.root.nodes.length
                                ) {
                                    r.root.nodes.forEach((node) => {
                                        const lookup = node.selector;

                                        if (
                                            lookup === `${selector}` ||
                                            lookup ===
                                                `${options.modifier}${selector}`
                                        ) {
                                            foundRule = node;
                                        }
                                    });
                                }
                            });

                            return foundRule;
                        }

                        // Loop through each inclusion rule root selector and
                        // prepend the nodes into it. These will get
                        // gzip'd/minified down so no extra optimization will be
                        // done here.
                        Array.from(inclusionRules).forEach((rule) => {
                            // Find the prefixed inclusion rule selector, this
                            // contains all scoped properties and definitions.
                            const foundRule = findSelector(`.${rule}`);

                            // If a rule is found, inject the root nodes into
                            // where the import was (essentially a replaceWith
                            // operation).
                            if (foundRule) {
                                let foundImport = false;

                                // Loop through all nodes and find where the
                                // import matches and replace with the new
                                // contents.
                                [...foundRule.nodes].forEach((node) => {
                                    if (isImportNode(node)) {
                                        // Create a fullpath to compare to.
                                        const filename = node.filename.replace(
                                            /'|"/g,
                                            ''
                                        );
                                        const fullpathCompare = options.resolve(
                                            filename,
                                            dirname(fromPath)
                                        );

                                        // This is the import to replace.
                                        if (fullpathCompare === fullpath) {
                                            foundImport = true;

                                            const compareIndex = foundRule.nodes.indexOf(
                                                node
                                            );
                                            foundRule.nodes.splice(
                                                compareIndex,
                                                1,
                                                ...root.nodes
                                            );
                                        }
                                    }
                                });

                                if (!foundImport) {
                                    throw new Error(
                                        'Unable to inject inclusion import, missing @import ' +
                                            fullpath
                                    );
                                }
                            } else {
                                throw new Error(
                                    'Missing inclusion rule selector ' + rule
                                );
                            }
                        });
                    }

                    // Fix issue with comments where a single line comment can
                    // accidentally break code generation. Keep all @condition
                    // comments to allow prefixing to work.
                    if (
                        prevNode &&
                        prevNode.type === 'comment' &&
                        !prevNode.text.includes('condition')
                    ) {
                        safeRemove(prevNode);
                    }
                }
            );

            // Inject the shared dependencies before all other styles.
            rootStyles.nodes.splice(0, 0, ...sharedDependencies);

            // Ensure all imports are scrubbed from the final output.
            removeAllImports(rootStyles);
        },
    };
}

ImportPlugin.postcss = true;

module.exports = ImportPlugin;
