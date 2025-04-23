/**
 * Cloudflare Worker to proxy WB Board Result API calls and handle payment verification.
 * Handles requests to /api/details and /api/full-result
 */

// --- Configuration ---
// IMPORTANT: Replace with the actual URL where your payment JSON is hosted
const PAYMENT_DB_URL = 'https://warisha.pw/payments';
// The base URL of the hidden backend API
const BOARD_API_BASE_URL = 'https://boardresultapi.abplive.com/wb/2024/12'; // Adjust year/board if needed

// --- CORS Headers ---
// Adjust Access-Control-Allow-Origin if you know your specific Pages domain
// Using '*' is generally okay for Pages/Worker interaction on the same account,
// but be more specific in high-security scenarios.
const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Or 'https://your-project-name.pages.dev'
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// --- Main Handler ---
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
            return await handleFullResultRequest(request);
        } else {
            return new Response(JSON.stringify({ message: 'Not Found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(`Worker Error on ${url.pathname}:`, error);
        return new Response(JSON.stringify({ message: error.message || 'Internal Server Error' }), {
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
             // Try to read error from API if possible, otherwise use status text
             let errorText = `API Error (${apiResponse.status}): ${apiResponse.statusText}`;
             try {
                 const errorJson = await apiResponse.json();
                 errorText = errorJson.message || errorText; // Use API's message if available
             } catch (e) { /* Ignore if response isn't JSON */ }

             // Return the specific error status from the API
             return new Response(JSON.stringify({ message: errorText }), {
                 status: apiResponse.status, // Pass through the status (e.g., 404)
                 headers: { ...corsHeaders, 'Content-Type': 'application/json' },
             });
        }

        const data = await apiResponse.json();

        // Select only the required fields for the details page
        const filteredData = {
            name: data.name,
            rollNo: data.ROll_No, // Match the property name from the API response
            regNo: data.Reg_No,   // Match the property name from the API response
            // DO NOT INCLUDE 'status' or other marks here
        };

        return new Response(JSON.stringify(filteredData), {
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


// --- Handler for Full Result (with Payment Verification) ---
async function handleFullResultRequest(request) {
    let requestData;
    try {
        requestData = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ message: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { paymentId, roll, no } = requestData;

    if (!paymentId || !roll || !no || !/^\d{6}$/.test(roll) || !/^\d{4}$/.test(no)) {
        return new Response(JSON.stringify({ message: 'Invalid Payment ID, Roll, or No format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Step 1: Verify Payment ---
    try {
        const paymentDbResponse = await fetch(PAYMENT_DB_URL, {
            // Add headers if needed for authentication or cache control
             headers: {
                // Example: If your JSON file is private, you might need an API key
                // 'Authorization': 'Bearer YOUR_SECRET_KEY',
                'Cache-Control': 'no-cache' // Ensure fresh data is fetched
             }
        });

        if (!paymentDbResponse.ok) {
            console.error(`Failed to fetch payment DB: ${paymentDbResponse.status}`);
            return new Response(JSON.stringify({ message: 'Could not verify payment status at this time (DB Error).' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const paymentData = await paymentDbResponse.json();

        if (!Array.isArray(paymentData)) {
             console.error('Payment data is not an array:', paymentData);
              return new Response(JSON.stringify({ message: 'Invalid payment data format.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const isValidPayment = paymentData.some(entry =>
            entry.payment_id === paymentId &&
            entry.roll === roll &&
            entry.no === no
        );

        if (!isValidPayment) {
            return new Response(JSON.stringify({ message: 'Payment verification failed. Check Payment ID, Roll, and No.' }), {
                status: 403, // Forbidden access
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('Error verifying payment:', error);
        return new Response(JSON.stringify({ message: 'Error during payment verification.' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    // --- Step 2: Fetch Full Result (Payment Verified) ---
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

             // Return the specific error status from the API
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
        return new Response(JSON.stringify({ message: 'Failed to connect to the results service after payment verification.' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}
