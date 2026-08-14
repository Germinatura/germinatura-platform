export function formatLocalDate(dateInput: string | Date | undefined | null): string {
    if (!dateInput) return "";
    const date = new Date(dateInput);
    
    // As datas que vêm do banco (especialmente campos date-only como dataInicio/Fim)
    // frequentemente são salvas como meia-noite UTC (00:00:00.000Z).
    // Quando convertidas para fuso horário local (ex: Brasil UTC-3), elas
    // retrocedem para 21:00 do dia anterior. 
    const isMidnightUTC = date.getUTCHours() === 0 && 
                          date.getUTCMinutes() === 0 && 
                          date.getUTCSeconds() === 0 && 
                          date.getUTCMilliseconds() === 0;

    if (isMidnightUTC) {
        return date.toLocaleDateString("pt-BR", { timeZone: "UTC" });
    }

    return date.toLocaleDateString("pt-BR");
}

export function formatCustomDate(dateInput: string | Date | undefined | null, options: Intl.DateTimeFormatOptions): string {
    if (!dateInput) return "";
    const date = new Date(dateInput);
    
    const isMidnightUTC = date.getUTCHours() === 0 && 
                          date.getUTCMinutes() === 0 && 
                          date.getUTCSeconds() === 0 && 
                          date.getUTCMilliseconds() === 0;

    if (isMidnightUTC) {
        return date.toLocaleDateString("pt-BR", { timeZone: "UTC", ...options });
    }
    
    return date.toLocaleDateString("pt-BR", options);
}

export function formatLocalTime(dateInput: string | Date | undefined | null): string {
    if (!dateInput) return "";
    const date = new Date(dateInput);
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
