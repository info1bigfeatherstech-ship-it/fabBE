const client = require("twilio")(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

exports.sendSMS = async (phone, message) => {
  const msg = await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE,
    to: phone
  });

  return {
    success: true,
    providerMessageId: msg.sid
  };
};