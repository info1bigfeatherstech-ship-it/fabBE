const express = require('express');
const router = express.Router();
const { addAddress, getAddresses, updateAddress, deleteAddress } = require('../controllers/address.controller');
const {verifyToken} = require('../middlewares/auth.middleware');

// Add a new address
router.post('/', verifyToken, addAddress);

// Get all addresses for a user
router.get('/', verifyToken, getAddresses);

// Update an address
router.put('/:id', verifyToken, updateAddress);

// Delete an address
router.delete('/:id', verifyToken, deleteAddress);

module.exports = router;