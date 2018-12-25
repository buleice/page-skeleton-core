'use strict';

const puppeteer = require('puppeteer');
const devices = require('puppeteer/DeviceDescriptors');
const {parse, toPlainObject, fromPlainObject, generate} = require('css-tree');
const {sleep, genScriptContent, htmlMinify, collectImportantComments} = require('./util');
const fs = require('fs');
const {puppeteerConfig, defaultOptions} = require('./config/config');

class SkeletonCore {

    constructor(options = {}, log) {
        const {puppeteerOptions, skeletonOptions} = options;
        this.puppeteerOptions = Object.assign({}, puppeteerConfig, puppeteerOptions);
        this.skeletonOptions = Object.assign({}, defaultOptions, skeletonOptions);
        this.browser = null;
        this.scriptContent = '';
        // this.log = log;

    }

    async initialize() {
        const {puppeteerOptions} = this;
        try {
            this.scriptContent = await genScriptContent();
            this.browser = await puppeteer.launch({
                //设置超时时间
                timeout: puppeteerOptions.timeout,
                //如果是访问https页面 此属性会忽略https错误
                ignoreHTTPSErrors: puppeteerOptions.ignoreHTTPSErrors,
                // 打开开发者工具, 当此值为true时, headless总为false
                devtools: puppeteerOptions.devtools,
                // 关闭headless模式, 不会打开浏览器
                headless: puppeteerOptions.headless
            });
        } catch (err) {
            // TODO LOG
            console.log('error----------------------------------');
            console.log(err)
        }
    }

    async newPage() {
        const {device, debug} = this.skeletonOptions;
        const page = await this.browser.newPage();
        await page.emulate(devices[device]);
        if (debug) {
            page.on('console', (...args) => {
                this.log.info(...args)
            })
        }
        return page
    }

    async makeSkeleton(page) {
        const {defer} = this.skeletonOptions;
        await page.addScriptTag({content: this.scriptContent});
        await sleep(defer);
        await page.evaluate((options) => {
            Skeleton.genSkeleton(options)
        }, this.skeletonOptions)
    }

    async build(url, options) {
        await this.initialize();
        Object.assign(this.puppeteerOptions, options);
        // TODO 各种钩子函数
        const stylesheetAstObjects = {};
        const stylesheetContents = {};
        const page = await this.newPage();
        const {cookies} = this.skeletonOptions;

        /**************************page 事件****************************/

        page.on('request', (request) => {
            if (stylesheetAstObjects[request.url]) {
                request.abort()
            } else {
                request.continue()
            }
        });

        page.on('response', (response) => {
            const requestUrl = response.url();
            const ct = response.headers()['content-type'] || '';
            if (response.ok && !response.ok()) {
                throw new Error(`${response.status} on ${requestUrl}`)
            }

            if (ct.indexOf('text/css') > -1 || /\.css$/i.test(requestUrl)) {
                response.text().then((text) => {
                    const ast = parse(text, {
                        parseValue: false,
                        parseRulePrelude: false
                    });
                    stylesheetAstObjects[requestUrl] = toPlainObject(ast);
                    stylesheetContents[requestUrl] = text
                })
            }
        });

        page.on('pageerror', (error) => {
            throw error
        });

        /**************************page 事件****************************/

        if (cookies.length) {
            await page.setCookie(...cookies.filter(cookie => typeof cookie === 'object'))
        }

        const response = await page.goto(url, {waitUntil: 'networkidle2'});
        await page.waitForSelector('.ad-data-report-carousel');
        if (response && !response.ok()) {
            throw new Error(`${response.status} on ${url}`)
        }

        await this.makeSkeleton(page);

        return Promise.resolve(1);

        const {styles, cleanedHtml} = await page.evaluate(() => Skeleton.getHtmlAndStyle());

        const stylesheetAstArray = styles.map((style) => {
            const ast = parse(style, {
                parseValue: false,
                parseRulePrelude: false
            });
            return toPlainObject(ast)
        });

        // eslint-disable-line no-shadow
        const cleanedCSS = await page.evaluate(async (stylesheetAstObjects, stylesheetAstArray) => {
            const DEAD_OBVIOUS = new Set(['*', 'body', 'html']);
            const cleanedStyles = [];

            const checker = (selector) => {
                if (DEAD_OBVIOUS.has(selector)) {
                    return true
                }
                if (/:-(ms|moz)-/.test(selector)) {
                    return true
                }
                if (/:{1,2}(before|after)/.test(selector)) {
                    return true
                }
                try {
                    return !!document.querySelector(selector)
                } catch (err) {
                    const exception = err.toString();
                    console.log(`Unable to querySelector('${selector}') [${exception}]`, 'error'); // eslint-disable-line no-console
                    return false
                }
            };

            const cleaner = (ast, callback) => {
                const decisionsCache = {};

                const clean = (children, cb) => children.filter((child) => {
                    if (child.type === 'Rule') {
                        const values = child.prelude.value.split(',').map(x => x.trim());
                        const keepValues = values.filter((selectorString) => {
                            if (decisionsCache[selectorString]) {
                                return decisionsCache[selectorString]
                            }
                            const keep = cb(selectorString);
                            decisionsCache[selectorString] = keep;
                            return keep
                        });
                        if (keepValues.length) {
                            // re-write the selector value
                            child.prelude.value = keepValues.join(', ');
                            return true
                        }
                        return false
                    } else if (child.type === 'Atrule' && child.name === 'media') {
                        // recurse
                        child.block.children = clean(child.block.children, cb);
                        return child.block.children.length > 0
                    }
                    // The default is to keep it.
                    return true
                });

                ast.children = clean(ast.children, callback);
                return ast
            };

            const links = Array.from(document.querySelectorAll('link'));

            links
                .filter(link => (
                    link.href &&
                    (link.rel === 'stylesheet' ||
                        link.href.toLowerCase().endsWith('.css')) &&
                    !link.href.toLowerCase().startsWith('blob:') &&
                    link.media !== 'print'
                ))
                .forEach((stylesheet) => {
                    if (!stylesheetAstObjects[stylesheet.href]) {
                        throw new Error(`${stylesheet.href} not in stylesheetAstObjects`)
                    }
                    if (!Object.keys(stylesheetAstObjects[stylesheet.href]).length) {
                        // If the 'stylesheetAstObjects[stylesheet.href]' thing is an
                        // empty object, simply skip this link.
                        return
                    }
                    const ast = stylesheetAstObjects[stylesheet.href];
                    cleanedStyles.push(cleaner(ast, checker))
                });
            stylesheetAstArray.forEach((ast) => {
                cleanedStyles.push(cleaner(ast, checker))
            });

            return cleanedStyles
        }, stylesheetAstObjects, stylesheetAstArray);
        const allCleanedCSS = cleanedCSS.map((ast) => {
            const cleanedAst = fromPlainObject(ast);
            return generate(cleanedAst)
        }).join('\n');
        const finalCss = collectImportantComments(allCleanedCSS);
        // finalCss = minify(finalCss).css ? `html-minifier` use `clean-css` as css minifier
        // so don't need to use another mimifier.
        let shellHtml = `<!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <title>Page Skeleton</title>
            <style>
              $$css$$
            </style>
            </head>
            <body>
            $$html$$
            </body>
            </html>`;
        shellHtml = shellHtml
            .replace('$$css$$', finalCss)
            .replace('$$html$$', cleanedHtml);
        const result = {
            html: htmlMinify(shellHtml, false)
        };
        await this.closePage(page);
        return Promise.resolve(result)
    }

    async closePage(page) {
        await page.close();
        return this;
    }

}

module.exports = SkeletonCore;
