const axios = require("axios");

exports.sendSMS = async (phone, message) => {
//     console.log("sendSMS FUNCTION CALLED");
//   console.log("FAST2SMS KEY:", process.env.FAST2SMS_API_KEY);
//   try{
//     const response = await axios.post(
//     "https://www.fast2sms.com/dev/bulkV2",
//     {
//       route: "otp",
//       message,
//       numbers: phone
//     },
//     {
//       headers: {
//         authorization: process.env.FAST2SMS_API_KEY
//       }
//     }
//   );

// //   return {
// //     success: true,
// //     providerMessageId: response.data.request_id
// //   };
// return response.data;
exports.sendSMS = async (phone, message) => {
    try{
  console.log("========== DEV MODE SMS ==========");
  console.log("Phone:", phone);
  console.log("Message:", message);
  console.log("===================================");

  return {
    status: "DEV_MODE",
    message: "SMS not sent. Logged in console."
  };
}catch(error){
   console.log("========== FAST2SMS ERROR ==========");
  console.log("Status:", error.response?.status);
  console.log("Response Data:", error.response?.data);
  console.log("Headers:", error.response?.headers);
  console.log("Message:", error.message);
  console.log("=====================================");

  throw error; // temporarily direct throw
}   
}
}

// MSG91 
//FAST