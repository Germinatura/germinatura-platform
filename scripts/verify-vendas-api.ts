const fetchVendas = async () => {
    try {
        const res = await fetch("http://localhost:3000/api/vendas?skip=0");
        const data = await res.json();
        console.log("API Response Keys:", Object.keys(data));
        console.log("Vendas Length:", data.transactions?.length);
        
        if (data.transactions && Array.isArray(data.transactions)) {
            console.log("Verification Successful: API returns paginated transactions.");
        } else {
            console.log("Verification Failed: Unexpected API structure.");
        }
    } catch (e: any) {
        console.error("Verification Error:", e?.message || e);
    }
};

fetchVendas();
