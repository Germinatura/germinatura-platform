const fetchTransactions = async () => {
    try {
        const res = await fetch("http://localhost:3000/api/transacoes?skip=0");
        const data = await res.json();
        console.log("API Response Keys:", Object.keys(data));
        console.log("Transactions Length:", data.transactions?.length);
        console.log("Totals:", data.totals);
        
        if (data.transactions && data.totals && typeof data.totals.entrada === 'number') {
            console.log("Verification Successful: API returns pagination and totals.");
        } else {
            console.log("Verification Failed: Unexpected API structure.");
        }
    } catch (e: any) {
        console.error("Verification Error:", e?.message || e);
    }
};

fetchTransactions();
