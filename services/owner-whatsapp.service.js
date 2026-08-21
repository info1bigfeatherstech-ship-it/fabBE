const axios = require('axios');

/**
 * Optional webhook for owner WhatsApp (paid integrations).
 * The default wholesaler onboarding flow uses admin-driven wa.me links instead.
 */
async function sendOwnerWhatsappMessage(payload) {
  const webhookUrl = String(process.env.WHATSAPP_OWNER_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    console.warn('[Wholesaler] WHATSAPP_OWNER_WEBHOOK_URL not configured. Owner message payload:', payload);
    return { delivered: false, reason: 'WHATSAPP_OWNER_WEBHOOK_URL not configured' };
  }

  const response = await axios.post(webhookUrl, payload, {
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' }
  });

  return {
    delivered: true,
    status: response.status,
    data: response.data
  };
}

module.exports = { sendOwnerWhatsappMessage };
