const axios = require("axios");

const API_KEY = process.env.TWOFACTOR_API_KEY;

exports.sendSMS = async (phone , otp) => {
  try {
 const url = `https://2factor.in/API/V1/${API_KEY}/SMS/91${phone}/${otp}`;
    const response = await axios.get(url);

    if (response.data.Status !== "Success") {
      throw new Error("2Factor SMS failed");
    }

    return response.data;
  } catch (error) {
     console.log("FULL ERROR ↓");
  console.log(error);

  if (error.response) {
    console.log("STATUS:", error.response.status);
    console.log("DATA:", error.response.data);
  }
    throw error;
  }
};
 