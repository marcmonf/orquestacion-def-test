const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
};

module.exports = notFoundHandler;
