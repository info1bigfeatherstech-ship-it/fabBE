const fast2sms = require("../providers/fast2sms.provider");
const twilio = require("../providers/twilio.provider");
const twofactor = require("../providers/factor2.provider");

const provider = process.env.SMS_PROVIDER;

let smsProvider;

if (provider === "twilio") {
  smsProvider = twilio;
} 
else if (provider === "2factor") {
  smsProvider = twofactor;
} 
else {
  smsProvider = fast2sms;
}

module.exports = smsProvider;