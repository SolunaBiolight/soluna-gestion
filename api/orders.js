export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(
        `https://api.tiendanube.com/v1/6978415/orders?per_page=200&page=${page}`,
        {
          headers: {
            'Authentication': 'bearer e0afbc53decaf8f8116003fc1023e18b0b94db9',
            'User-Agent': 'SolunaGestion (soluna.biolight@gmail.com)'
          }
        }
      );
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        hasMore = false;
      } else {
        allOrders = allOrders.concat(data);
        if (data.length < 200) hasMore = false;
        else page++;
      }
    }

    res.status(200).json(allOrders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}