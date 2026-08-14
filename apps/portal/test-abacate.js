const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

function generateCPF() {
  const rnd = n => Math.round(Math.random() * n);
  const mod = (base, div) => Math.round(base - Math.floor(base / div) * div);
  const n = Array(9).fill(0).map(() => rnd(9));
  let d1 = n.reduce((total, number, index) => total + number * (10 - index), 0);
  d1 = 11 - mod(d1, 11);
  if (d1 >= 10) d1 = 0;
  let d2 = d1 * 2 + n.reduce((total, number, index) => total + number * (11 - index), 0);
  d2 = 11 - mod(d2, 11);
  if (d2 >= 10) d2 = 0;
  return `${n.join("")}${d1}${d2}`;
}

const options = {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.ABACATEPAY_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    method: "PIX",
    data: {
      amount: 100 + 80, // 1 real da rifa + 80 centavos de taxa
      description: 'Teste V2 com Taxa',
      customer: {
        name: 'Daniel Lima',
        cellphone: '(11) 4002-8922',
        email: 'daniel@abacatepay.com',
        taxId: generateCPF()
      }
    }
  })
};

fetch('https://api.abacatepay.com/v2/transparents/create', options)
  .then(res => res.json())
  .then(res => {
    fs.writeFileSync('out.json', JSON.stringify(res, null, 2));
    console.log("Written to out.json");
  })
  .catch(err => console.error("FETCH ERROR:", err));
