export default class BaseService {
    /**
     * Sends a POST request to the specified URL.
     * @param {string} url - The endpoint URL.
     * @param {object} body - The request body.
     * @param {object} [headers={}] - Optional headers.
     * @returns {Promise<{data: any, status: number}>} The response data and status code.
     * @throws {Error} If the response is not ok.
     */
    async sendPOSTRequest(url, body, headers = {}) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const responseBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${response.statusText} on POST ${url} - ${responseBody}`);
        }

        const data = await response.json();
        return { data, status: response.status };
    }

    /**
     * Sends a GET request to the specified URL.
     * @param {string} url - The endpoint URL.
     * @param {object} [headers={}] - Optional headers.
     * @returns {Promise<{data: any, status: number}>} The response data and status code.
     * @throws {Error} If the response is not ok.
     */
    async sendGETRequest(url, headers = {}) {
        const response = await fetch(url, {
            method: 'GET',
            headers
        });

        if (!response.ok) {
            const responseBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${response.statusText} on GET ${url} - ${responseBody}`);
        }

        const data = await response.json();
        return { data, status: response.status };
    }
}
