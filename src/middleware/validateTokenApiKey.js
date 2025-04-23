// src/middleware/validateTokenApiKey.js
module.exports = (req, res, next) => {
  const tokenApiKey = req.headers['x-api-key'];
  if (!tokenApiKey || tokenApiKey !== process.env.TOKEN_API_KEY) {
    return res.status(403).json({
      success: false,
      message: res.getMessage('error.invalidApiKey')
    });
  }
  next();
};
