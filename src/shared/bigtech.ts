// "Big Tech" for the Jobs filter: the large tech companies and their units, matched on the company name.
const BIG_TECH = /\b(apple|google|alphabet|waymo|deepmind|amazon|aws|microsoft|meta|facebook|nvidia|tesla|spacex|netflix|intel|amd|advanced micro devices|qualcomm|ibm|cisco|oracle|samsung|sony|uber|salesforce|adobe|broadcom|texas instruments|applied materials|asml|lam research|kla|micron|dell|hp|hewlett packard|zoox|blue origin|anduril|openai|anthropic|shopify|boston dynamics|xai)\b/i

export const isBigTech = (company: string): boolean => BIG_TECH.test(company.replace(/\(.*?\)/g, ' '))
