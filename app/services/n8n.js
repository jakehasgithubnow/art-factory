import axios from 'axios';

/**
 * Sends the processed artwork payload to the n8n webhook.
 * @param {Object} payload - The full JSON body matching the expected n8n format.
 */
export async function sendProduct(payload) {
  try {
    const res = await axios.post(
      'https://n8n101301.hostkey.in/webhook/7686524a-8012-485a-bc49-076d980323f8',
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    console.log('[n8n] Webhook sent successfully:', res.status);
  } catch (err) {
    console.error('[n8n] Error sending webhook:', err.message);
    if (err.response) {
      console.error('Response data:', err.response.data);
    }
  }
}
