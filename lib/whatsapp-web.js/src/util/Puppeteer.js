/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    try {
        const exist = await page.evaluate((name) => {
            return !!window[name];
        }, name).catch(() => false);
        if (exist) {
            return;
        }
        await page.exposeFunction(name, fn).catch((err) => {
            // Ignore error if function was already exposed or page navigated
            if (!err.message?.includes('already exists')) {
                // target closed or navigated
            }
        });
    } catch (e) {
        // Page target error during evaluation, ignore safely
    }
}

module.exports = { exposeFunctionIfAbsent };
