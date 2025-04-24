// --- Configuration ---
// IMPORTANT: Replace with the actual URL where your payment JSON is hosted
const PAYMENT_DB_URL = 'https://warisha.pw/payments';
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

// --- Main Handler (Remains the same) ---
// ... (keep existing code) ...

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

        // Select only the required fields for the details page
        // *** AND ADD THE PAYMENT BUTTON ID ***
        const responsePayload = {
            name: data.name,
            rollNo: data.ROll_No,
            regNo: data.Reg_No,
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


// --- Handler for Full Result (Remains the same) ---
// ... (keep existing handleFullResultRequest code) ...

// *** Add the onRequest export if it's missing (should be there from your original code) ***
export { onRequest };
