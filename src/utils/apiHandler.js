// apiHandler.js
// A dynamic HTTP helper using axios that supports multiple output formats,
// basic retries, and sane defaults for headers/timeouts.

import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * apiRequest(url, options)
 *
 * @param {string} url - Target URL
 * @param {object} options
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} [options.method='GET']
 * @param {object} [options.headers] - Extra headers
 * @param {object} [options.query] - Query params (axios 'params')
 * @param {any}    [options.body] - Request body for non-GET
 * @param {number} [options.timeout=15000] - ms
 * @param {number} [options.retries=2] - retry attempts on failure
 * @param {number} [options.retryDelayMs=500] - delay between retries
 * @param {'json'|'text'|'buffer'|'cheerio'|'raw'} [options.format='json']
 *        - json: parse JSON (throws if invalid)
 *        - text: return UTF-8 string
 *        - buffer: return Buffer
 *        - cheerio: return Cheerio '$' root (for HTML parsing)
 *        - raw: return the full axios response object
 *
 * @returns {Promise<any>} - Data in the requested format
 */
async function apiRequest(url, {
  method = 'GET',
  headers = {},
  query = undefined,
  body = undefined,
  timeout = 15000,
  retries = 2,
  retryDelayMs = 500,
  format = 'json',
} = {}) {
  const defaultHeaders = {
    // Realistic defaults for public pages
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-GB,en;q=0.9',
  };

  // Map desired format to axios responseType
  const responseType =
    format === 'buffer' ? 'arraybuffer'
    : format === 'raw' ? 'arraybuffer' // we’ll keep body as-is, but return the full response
    : 'text'; // safer to parse ourselves for json/text/cheerio

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await axios.request({
        url,
        method,
        headers: { ...defaultHeaders, ...headers },
        params: query,
        data: body,
        timeout,
        // Keep raw text so we can choose how to parse
        responseType,
        // Avoid axios auto-JSON parsing; we handle it
        transformResponse: [data => data],
        validateStatus: status => status >= 200 && status < 400,
      });

      // If caller wants the full axios response
      if (format === 'raw') return resp;

      // Parse by format
      if (format === 'buffer') {
        return Buffer.from(resp.data);
      }

      // From here, resp.data is string
      const text = typeof resp.data === 'string'
        ? resp.data
        : Buffer.isBuffer(resp.data)
          ? resp.data.toString('utf-8')
          : String(resp.data ?? '');

      if (format === 'text') return text;

      if (format === 'json') {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to parse JSON (status ${resp.status})`);
        }
      }

      if (format === 'cheerio') {
        return cheerio.load(text);
      }

      // Fallback: return text
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, retryDelayMs));
        continue;
      }
      throw lastError;
    }
  }
}

/**
 * printPreview(data, format, maxLen=500)
 * - Convenience helper to log a concise preview of the response.
 */
function printPreview(data, format = 'json', maxLen = 500) {
  if (format === 'buffer') {
    console.log(`Buffer length: ${data?.length ?? 0}`);
    return;
  }
  if (format === 'cheerio') {
    console.log('Cheerio root loaded. Example:', typeof data, 'Use $("selector").text() etc.');
    return;
  }
  if (format === 'raw') {
    console.log(`Raw response: status=${data?.status}, headers=${Object.keys(data?.headers || {}).length}`);
    return;
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  console.log(text.length > maxLen ? text.slice(0, maxLen) + '... [truncated]' : text);
}


export {
  apiRequest,
  printPreview,
}
