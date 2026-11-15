import type { RawJob, Region } from '../shared/types'
import { KNOWN } from './companies'

const ONTARIO = /\b(ontario|toronto|ottawa|mississauga|brampton|hamilton|waterloo|kitchener|cambridge, on|london, on|markham|vaughan|oakville|burlington|oshawa|windsor, on|guelph|kingston, on|barrie|sudbury|thunder bay|st\.? catharines|niagara|richmond hill|ajax|pickering|whitby|milton, on|kanata|peterborough|sarnia|woodstock, on|alliston|ingersoll|aurora, on|newmarket|concord, on|etobicoke|scarborough|north york|stoney creek|brantford|chatham|belleville|cornwall, on|bolton, on|tiverton|chalk river|clarington|darlington|gta)\b|,\s*ON\b|\bON,\s*(CA|CAN|Canada)\b/i
const CANADA = /\b(canada|quebec|québec|montreal|montréal|british columbia|vancouver|alberta|calgary|edmonton|manitoba|winnipeg|saskatchewan|saskatoon|regina|nova scotia|halifax|new brunswick|newfoundland|victoria, bc|burnaby|richmond, bc|laval|longueuil|mirabel|saint-laurent|dorval)\b|,\s*(QC|BC|AB|MB|SK|NS|NB|NL|PE)\b|\bCAN\b/i
const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'
const US_NAMES = 'alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio oklahoma oregon pennsylvania rhode island|south carolina|south dakota|tennessee texas utah vermont virginia washington west virginia|wisconsin wyoming'
const USA = new RegExp(`\\b(united states|usa|u\\.s\\.a?\\.?|us-[a-z]{2}|${US_NAMES.replace(/ (?![a-z]+\|)/g, '|')})\\b|,\\s*(${US_STATES.split(' ').join('|')})\\b|\\bUS\\b|\\b(${US_STATES.split(' ').join('|')})\\s*-\\s|\\bUS,|-\\s*US\\b`, 'i')
const ELSEWHERE = /\b(india|china|japan|korea|germany|france|united kingdom|uk|england|ireland|mexico|brazil|singapore|taiwan|israel|poland|netherlands|australia|new zealand|italy|spain|sweden|switzerland|malaysia|philippines|vietnam|thailand|czech|hungary|romania|austria|belgium|denmark|norway|finland|portugal|turkey|uae|dubai|saudi|egypt|south africa|costa rica|colombia|argentina|chile|bangalore|bengaluru|hyderabad|pune|chennai|shanghai|beijing|shenzhen|tokyo|munich|berlin|paris|london, (uk|england)|penang|auckland|armenia|yerevan|georgia, (ge|tbilisi)|tbilisi|bulgaria|croatia|estonia|latvia|lithuania|slovenia|iceland|cyprus|malta|luxembourg|slovakia|taipei|tel aviv|haifa|dublin|eemshaven|hong kong|indonesia|qatar|serbia|greece|ukraine|peru|morocco|kenya|nigeria|pakistan|bangladesh|sri lanka)\b/i
// Three-letter country codes, as Amazon and Boeing write them ("Luxembourg, LUX", "GBR - Hounslow").
const ISO3_ELSEWHERE = /\b(SGP|LUX|GBR|DEU|ITA|POL|IND|JPN|CHN|FRA|ESP|MEX|BRA|AUS|IRL|NLD|ISR|KOR|TWN|CZE|ROU|CRI|ARE|SAU|ZAF|QAT|MYS|PHL|SWE|CHE|BEL|AUT|TUR|EGY|COL|ARG|CHL|SVK|HUN|PRT|DNK|NOR|FIN|NZL|VNM|THA|IDN|HKG|SRB|GRC|UKR|BGR|JOR|BHR|KWT|OMN|MAR)\b/

// The four US areas where lesser-known employers are still kept. New York means the city, not the state.
const KEY_US = new RegExp([
  String.raw`\b(california|texas|florida|new york city|nyc|new york,\s*(ny|new york)|brooklyn|manhattan|queens|bronx|long island city|staten island)\b`,
  String.raw`,\s*(CA|TX|FL)\b(?!\s*,\s*(CA|CAN|Canada)\b)|\b(CA|TX|FL)\s*-\s|\bUS-(CA|TX|FL)\b`,
  String.raw`\b(san francisco|los angeles|san diego|san jose|palo alto|mountain view|sunnyvale|santa clara|cupertino|hawthorne|el segundo|long beach|irvine|fremont|oakland|menlo park|redwood city|torrance|costa mesa|santa monica|pasadena|bay area|silicon valley|foster city|san mateo|san carlos|alameda|emeryville|berkeley|burbank|culver city|gardena|vandenberg|mojave|sacramento|austin|houston|dallas|san antonio|fort worth|starbase|el paso|plano|cape canaveral|orlando|miami|tampa|jacksonville|kennedy space center|merritt island)\b`
].join('|'), 'i')
/** True when a US location is in California, Texas, Florida or New York City. */
export const inKeyUsArea = (location: string): boolean => KEY_US.test(location || '')
/** Whether a job's US location is allowed for this employer: anywhere for household names, the four key areas for everyone else. */
export const usAllowed = (company: string, location: string): boolean => KNOWN.has(company) || inKeyUsArea(location)
// Big employers that post one pooled internship for all teams, with a description too general to mention mechanical work.
const POOLED = /\b(product design|hardware|manufacturing design)\b.*\bundergrad/i

export function regionOf(location: string): Region | 'unknown' {
  const loc = location || ''
  if (ONTARIO.test(loc)) return 'ontario'
  if (CANADA.test(loc)) return 'canada'
  if ((ELSEWHERE.test(loc) || ISO3_ELSEWHERE.test(loc)) && !USA.test(loc)) return 'other'
  if (USA.test(loc)) return 'usa'
  return 'unknown'
}

const INTERN = /\b(intern|interns|internship|internships|co-?op|student|summer (20\d\d|term|analyst|associate)|pey|stagiaire|apprentice)\b/i
export const isInternTitle = (title: string): boolean => INTERN.test(title.replace(NOT_INTERN, ''))
const NOT_INTERN = /\b(manager of interns|internal|international)\b/i
const ME_TITLE = /\b(mechanical|mechatronics?|manufacturing|thermal|thermo|fluids?|structures?|structural|propulsion|aerospace|aeronautical|robotics?|hardware|design eng|product design|test eng|materials?|quality eng|process eng|industrial eng|automation|tooling|cad|mechanisms?|vehicle|powertrain|chassis|battery|hvac|reliability|systems eng|production eng|build eng|integration|launch|avionics mech|nuclear|energy|equipment|facilities eng|r&d|research and development|product development|engineering)\b/i
const OFF_TITLE = /\b(software|firmware|data sci|data eng|data analy|machine learning|\bml\b|\bai\b|finance|financial|accounting|marketing|legal|recruit|talent|human resources|\bhr\b|sales|business|supply chain|procurement|communications|design (ux|ui)|ux|ui|graphic|security eng|it support|information technology|cyber|web|cloud|devops|backend|frontend|full.?stack|electrical|electronics|\basic\b|fpga|rf\b|digital design|analog|verification|chemist|biolog|clinical|regulatory|policy|tax|audit|payroll|pilot|nurs|phd|ph\.d|mba)\b/i
const ME_BODY = /\b(mechanical|mechatronics|solidworks|catia|siemens nx|creo|autocad|ansys|gd&t|finite element|fea\b|cfd\b|machining|cnc|3d print|additive manufacturing|dfm|thermodynamics|heat transfer|fluid mechanics)\b/i

export interface FilterVerdict { keep: boolean; region: Region; reason: string }

/** Hard filter that runs before any AI call. needBody = keep is undecided until the description is fetched. */
export function checkJob(j: RawJob): FilterVerdict & { needBody?: boolean } {
  // Vague locations ("3 Locations", "Any SpaceX Site") are common at large employers. Every curated large
  // employer hires in North America, so those are kept and the location is pinned down from the posting later.
  const raw = regionOf(j.location)
  const vague = raw === 'unknown'
  if (raw === 'other' || (vague && !j.big)) return { keep: false, region: 'other', reason: 'outside North America or location unclear' }
  const region: Region = vague ? 'usa' : raw
  if (region !== 'ontario' && !j.big) return { keep: false, region, reason: 'not a large employer outside Ontario' }
  // A vague location is let through here and settled once the posting itself has been read (see refresh.ts).
  if (raw === 'usa' && !usAllowed(j.company, j.location)) return { keep: false, region, reason: 'lesser-known employer outside California, Texas, Florida and New York City' }
  const title = j.title
  if (!INTERN.test(title.replace(NOT_INTERN, ''))) return { keep: false, region, reason: 'not an internship or co-op' }
  if (/\b(phd|ph\.d\.?|doctoral|mba)\b/i.test(title)) return { keep: false, region, reason: 'graduate-degree role' }
  const mechInTitle = /\b(mechanical|mechatronics?)\b/i.test(title)
  if (!mechInTitle && OFF_TITLE.test(title)) return { keep: false, region, reason: 'different discipline' }
  const needLoc = (vague && j.source === 'workday') || (!j.description && !!j.detailUrl)
  if (mechInTitle) return { keep: true, region, reason: 'mechanical internship', needBody: needLoc || undefined }
  if (!ME_TITLE.test(title)) return { keep: false, region, reason: 'title is not engineering' }
  // Engineering-flavoured title without "mechanical": needs the description to mention ME work.
  if (!j.description) return { keep: true, region, reason: 'needs description check', needBody: true }
  if (POOLED.test(title) && KNOWN.has(j.company)) return { keep: true, region, reason: 'pooled hardware internship at a large employer', needBody: needLoc || undefined }
  return ME_BODY.test(j.description)
    ? { keep: true, region, reason: 'engineering internship that mentions mechanical work', needBody: needLoc || undefined }
    : { keep: false, region, reason: 'description does not mention mechanical work' }
}
