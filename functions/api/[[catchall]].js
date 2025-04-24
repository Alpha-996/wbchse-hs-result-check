/**
 * Cloudflare Worker to proxy WB Board Result API calls and handle payment verification.
 * Handles requests to /api/details and /api/full-result
 */

// --- Configuration ---
// IMPORTANT: Replace with the actual URL where your payment JSON is hosted
const PAYMENT_DB_URL = 'https://warisha.pw/payments'; // Example URL
// The base URL of the hidden backend API
const BOARD_API_BASE_URL = 'https://boardresultapi.abplive.com/wb/2024/12'; // Adjust year/board if needed
// *** ADD YOUR RAZORPAY BUTTON ID HERE (Ideally from environment variable) ***
const RAZORPAY_BUTTON_ID = 'pl_QMXOuva67vyoan'; // Replace with your actual ID

// --- CORS Headers ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Consider restricting this in production
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// --- Main Handler ---
// This is the primary export Cloudflare looks for
export async function onRequest(context) {
    const { request } = context;
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
            return await handleDetailsRequest(request);
        } else if (url.pathname === '/api/full-result') {
            // Pass context if needed by handlers (e.g., for environment variables)
            return await handleFullResultRequest(request, context);
        } else {
            return new Response(JSON.stringify({ message: 'Not Found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(`Worker Error on ${url.pathname}:`, error);
        // Avoid leaking detailed error messages in production if possible
        const errorMessage = (error instanceof Error) ? error.message : 'Internal Server Error';
        return new Response(JSON.stringify({ message: errorMessage }), {
            status: 500, // Generic server error
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- Handler for Basic Details ---
async function handleDetailsRequest(request) {
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { roll, no } = requestData;

    if (!roll || !no || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no)) {
        return new Response(JSON.stringify({ message: 'Invalid Roll or No format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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

        // Select required fields and add the payment button ID
        const responsePayload = {
            name: data.name,
            rollNo: data.ROll_No, // Corrected key based on your previous code
            regNo: data.Reg_No,   // Corrected key based on your previous code
            paymentButtonId: RAZORPAY_BUTTON_ID // Include the ID here
        };

        return new Response(JSON.stringify(responsePayload), { // Send the modified payload
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error fetching from board API (details):', error);
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service.' }), {
            status: 502, // Bad Gateway might be appropriate
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- Handler for Full Result (with Payment/Identifier Verification) ---
// Added 'context' parameter in case environment variables are needed later
async function handleFullResultRequest(request, context) {
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Expect 'identifier' (Payment ID/Email/Phone) ---
    const { identifier, roll, no } = requestData;

    if (!identifier || !roll || !no || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no)) {
        return new Response(JSON.stringify({ message: 'Invalid Identifier (Payment ID/Email/Phone), Roll, or No format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Step 1: Verify Identifier, Roll, and No against Payment DB ---
    try {
        const paymentDbResponse = await fetch(PAYMENT_DB_URL, {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
            // Optional: Add Cloudflare cache settings if needed
            // cf: { cacheTtl: 0 } // Example: bypass Cloudflare cache for this fetch
        });

        if (!paymentDbResponse.ok) {
            console.error(`Failed to fetch payment DB: ${paymentDbResponse.status} ${paymentDbResponse.statusText}`);
            return new Response(JSON.stringify({ message: 'Could not verify details at this time (DB Error).' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const paymentData = await paymentDbResponse.json();

        if (!Array.isArray(paymentData)) {
            console.error('Payment data is not an array:', paymentData);
            return new Response(JSON.stringify({ message: 'Invalid payment data format.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // --- Verification Logic ---
        const isValidEntry = paymentData.some(entry =>
            (String(entry.payment_id) === String(identifier) || String(entry.email) === String(identifier) || String(entry.phone) === String(identifier)) && // Compare as strings for safety
            String(entry.roll) === String(roll) &&
            String(entry.no) === String(no)
        );

        if (!isValidEntry) {
            return new Response(JSON.stringify({ message: 'Verification failed. Check Identifier (Payment ID/Email/Phone), Roll, and No combination.' }), {
                status: 403, // Forbidden access
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Verification passed

    } catch (error) {
        console.error('Error verifying identifier/payment:', error);
        return new Response(JSON.stringify({ message: 'Error during details verification.' }), {
            status: 500, // Internal server error during verification step
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    // --- Step 2: Fetch Full Result (Verification Passed) ---
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

            return new Response(JSON.stringify({ message: errorText }), {
                status: apiResponse.status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const data = await apiResponse.json(); // Get the full data

        // Return the complete data
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error fetching from board API (full result):', error);
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service after verification.' }), {
            status: 502, // Bad Gateway - problem connecting to the upstream API
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}
