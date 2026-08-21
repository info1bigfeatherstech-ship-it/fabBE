// controllers/chat.controller.js
const processUserMessage=require("../services/ai.service.js");

 const handleChat = async (req, res, next) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const result = await processUserMessage(message);

    return res.status(200).json({
      success: true,
      ...result
    });

  } catch (error) {
    next(error);
  }
};

module.exports=handleChat;