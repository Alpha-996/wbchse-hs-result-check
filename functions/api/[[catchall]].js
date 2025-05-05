/**
 * Cloudflare Worker to proxy WB Board Result API calls, handle referrals, and payment verification.
 * Handles requests to /api/details and /api/full-result
 */

// --- Configuration ---
const PAYMENT_DB_URL = 'https://warisha.pw/payments'; // Replace with your actual payment DB URL
const BOARD_API_BASE_URL = 'https://boardresultapi.abplive.com/wb/2024/12'; // Adjust year/board if needed

// --- START: Referral Configuration (Moved to Backend) ---
// Map referral keys (lowercase) to specific Razorpay Button IDs
const referralButtonMap = {
    'subhra': 'pl_QRCx74QvShiAil', // Button ID for Subhra
    'koyel': 'pl_QMWdxwIPVZYTpi'   // Button ID for Koyel
    // Add more friends here: 'friendname': 'button_id'
};
// Define the default Button ID (used if the referralKey doesn't match)
const defaultRazorpayButtonId = 'pl_QMXOuva67vyoan'; // Your original default ID
// --- END: Referral Configuration ---


// --- CORS Headers ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Consider restricting this in production: e.g., 'https://yourdomain.com'
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// --- Main Handler ---
export async function onRequest(context) {
    const { request, env } = context; // `env` holds environment variables if set
    const url = new URL(request.url);

    // Handle CORS preflight requests (OPTIONS)
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // Only allow POST requests for our API endpoints
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    // --- Routing ---
    try {
        if (url.pathname === '/api/details') {
            // Pass env variables if needed (e.g., if button IDs are stored there)
            return await handleDetailsRequest(request, env);
        } else if (url.pathname === '/api/full-result') {
            return await handleFullResultRequest(request, env); // Pass env if needed
        } else {
            return new Response(JSON.stringify({ message: 'Not Found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(`Worker Error on ${url.pathname}:`, error);
        const errorMessage = (error instanceof Error) ? error.message : 'Internal Server Error';
        return new Response(JSON.stringify({ message: errorMessage }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- Handler for Basic Details (Now with Referral Logic) ---
async function handleDetailsRequest(request, env) { // Added env parameter
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Read roll, no, and the new referralKey ---
    const { roll, no, referralKey } = requestData;

    if (!roll || !no || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no)) {
        return new Response(JSON.stringify({ message: 'Invalid Roll or No format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Determine the correct Razorpay Button ID ---
    let paymentButtonIdToUse = defaultRazorpayButtonId; // Start with the default
    if (referralKey && referralButtonMap[referralKey.toLowerCase()]) {
        // If a valid referralKey was sent and exists in our map, use that ID
        paymentButtonIdToUse = referralButtonMap[referralKey.toLowerCase()];
    }
    // You could also potentially override these with environment variables:
    // paymentButtonIdToUse = env[referralKey.toUpperCase() + '_BUTTON_ID'] || defaultRazorpayButtonId;
    // --- End Button ID Determination ---


    const fullRoll = roll + no;
    const apiUrl = `${BOARD_API_BASE_URL}/${fullRoll}`;

    try {
        const apiResponse = await fetch(apiUrl);

        if (!apiResponse.ok) {
            let errorText = `API Error (${apiResponse.status}): ${apiResponse.statusText}`;
            try {
                const errorJson = await apiResponse.json();
                errorText = errorJson.message || errorText;
            } catch (e) { /* Ignore if response isn't JSON */ }

            return new Response(JSON.stringify({ message: errorText }), {
                status: apiResponse.status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const data = await apiResponse.json();

        // --- Select required fields and add the *determined* payment button ID ---
        const responsePayload = {
            name: data.name,
            rollNo: data.ROll_No,
            regNo: data.Reg_No,
            paymentButtonId: paymentButtonIdToUse // Use the ID determined above
        };

        return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error fetching from board API (details):', error);
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service.' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- Handler for Full Result (with Payment/Identifier Verification) ---
// No changes needed here for the referral logic, but passing 'env' for consistency
async function handleFullResultRequest(request, env) { // Added env parameter
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { identifier, roll, no } = requestData;

    if (!identifier || !roll || !no || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no)) {
        return new Response(JSON.stringify({ message: 'Invalid Identifier (Payment ID/Email/Phone), Roll, or No format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Step 1: Verify Identifier, Roll, and No against Payment DB ---
    try {
        const paymentDbResponse = await fetch(PAYMENT_DB_URL, {
            headers: { // Ensure fresh data is fetched
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            // Optional: Bypass Cloudflare cache for this specific fetch if needed
            // cf: { cacheTtl: 0 }
        });

        if (!paymentDbResponse.ok) {
            console.error(`Failed to fetch payment DB: ${paymentDbResponse.status} ${paymentDbResponse.statusText}`);
            return new Response(JSON.stringify({ message: 'Could not verify details at this time (DB Error).' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const paymentData = await paymentDbResponse.json();

        if (!Array.isArray(paymentData)) {
            console.error('Payment data is not an array:', paymentData);
            return new Response(JSON.stringify({ message: 'Payment data format error.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Normalize identifier for comparison (e.g., lowercase email)
        const normalizedIdentifier = identifier.toLowerCase();

        // Find a matching payment record
        const isValidPayment = paymentData.some(record =>
            record.roll === roll &&
            record.no === no &&
            (
                (record.payment_id && record.payment_id.toLowerCase() === normalizedIdentifier) ||
                (record.email && record.email.toLowerCase() === normalizedIdentifier) ||
                (record.phone && record.phone === identifier) // Assuming phone is stored as string digits
            )
        );

        if (!isValidPayment) {
            return new Response(JSON.stringify({ message: 'Verification failed. Payment not found or details mismatch.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

    } catch (error) {
        console.error('Error verifying payment:', error);
        return new Response(JSON.stringify({ message: 'Error during payment verification.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Step 2: If verification passed, fetch the full result ---
    const fullRoll = roll + no;
    const apiUrl = `${BOARD_API_BASE_URL}/${fullRoll}`;

    try {
        const apiResponse = await fetch(apiUrl);

        if (!apiResponse.ok) {
             let errorText = `API Error (${apiResponse.status}): ${apiResponse.statusText}`;
             try {
                 const errorJson = await apiResponse.json();
                 errorText = errorJson.message || errorText;
             } catch (e) { /* Ignore */ }

             // Handle specific case where result exists but details couldn't be fetched after payment check
             if (apiResponse.status === 404) {
                 errorText = 'Result found, but could not retrieve full details after verification. Please contact support.';
             }

             return new Response(JSON.stringify({ message: errorText }), {
                 status: apiResponse.status === 404 ? 500 : apiResponse.status, // Return 500 if 404 after verification
                 headers: { ...corsHeaders, 'Content-Type': 'application/json' },
             });
        }

        const resultData = await apiResponse.json();

        // --- Return the full result data ---
        return new Response(JSON.stringify(resultData), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error fetching from board API (full result):', error);
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service for full details.' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}
