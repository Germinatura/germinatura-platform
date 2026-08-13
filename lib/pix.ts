/**
 * Utilitário para geração de Payload PIX Padrão BR Code (BACEN)
 * Refatorado do código original em index.html
 */

export function calculaCRC16(str: string): string {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc = crc << 1;
            }
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

export interface PixConfig {
    chave: string;
    nome: string;
    cidade: string;
    valor: string; // Formato "10.00"
}

export function montarPayloadPix({ chave, nome, cidade, valor }: PixConfig): string {
    // Formatação padrão exigida pelo Banco Central
    const payloadKey = `0014br.gov.bcb.pix01${chave.length.toString().padStart(2, '0')}${chave}`;

    // Tag 54 (Valor) deve ter o tamanho correto
    const valorFormatado = parseFloat(valor).toFixed(2);

    const payload = [
        "000201", // Payload Format Indicator
        "26", // Merchant Account Information (Tag 26)
        payloadKey.length.toString().padStart(2, '0'),
        payloadKey,
        "52040000", // Merchant Category Code
        "5303986", // Transaction Currency (986 = BRL)
        "54", // Transaction Amount
        valorFormatado.length.toString().padStart(2, '0'),
        valorFormatado,
        "5802BR", // Country Code
        "59", // Merchant Name
        nome.length.toString().padStart(2, '0'),
        nome,
        "60", // Merchant City
        cidade.length.toString().padStart(2, '0'),
        cidade,
        "62070503***", // Additional Data Field Template
        "6304" // CRC
    ].join("");

    return payload + calculaCRC16(payload);
}
