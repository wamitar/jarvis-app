// Curated job boards, each checked against the live public endpoint on 2026-11-14.
// big = searched across the USA and Canada: large employers plus larger hardware startups.
// Boards marked false only contribute Ontario jobs.
import type { Board } from '../shared/types'

const b = (company: string, ats: Board['ats'], id: string, big = true): Board => ({ company, ats, id, big })

export const BOARDS: Board[] = [
  // Greenhouse
  b('SpaceX', 'greenhouse', 'spacex'), b('Anduril', 'greenhouse', 'andurilindustries'), b('Relativity Space', 'greenhouse', 'relativity'),
  b('Lucid Motors', 'greenhouse', 'lucidmotors'), b('Waymo', 'greenhouse', 'waymo'), b('Nuro', 'greenhouse', 'nuro'),
  b('Figure', 'greenhouse', 'figureai'), b('Archer Aviation', 'greenhouse', 'archer56'), b('Rocket Lab', 'greenhouse', 'rocketlab'),
  b('Astranis', 'greenhouse', 'astranis'), b('Axon', 'greenhouse', 'axon'), b('Zipline', 'greenhouse', 'flyzipline'),
  b('Formlabs', 'greenhouse', 'formlabs'), b('Neuralink', 'greenhouse', 'neuralink'), b('Redwood Materials', 'greenhouse', 'redwoodmaterials'),
  b('Samsara', 'greenhouse', 'samsara'), b('Verkada', 'greenhouse', 'verkada'), b('Peloton', 'greenhouse', 'peloton'),
  b('Motional', 'greenhouse', 'motional'), b('Agility Robotics', 'greenhouse', 'agilityrobotics'), b('Apptronik', 'greenhouse', 'apptronik'),
  b('Ursa Major', 'greenhouse', 'ursamajor'), b('Varda Space', 'greenhouse', 'vardaspace'), b('Kairos Power', 'greenhouse', 'kairospower'),
  b('Oklo', 'greenhouse', 'oklo'), b('Locus Robotics', 'greenhouse', 'locusrobotics', false), b('Markforged', 'greenhouse', 'markforged', false),
  b('Heart Aerospace', 'greenhouse', 'heartaerospace'), b('Geotab', 'greenhouse', 'geotab', false), b('Tulip', 'greenhouse', 'tulip', false),
  // Lever
  b('Zoox', 'lever', 'zoox'), b('Bright Machines', 'lever', 'brightmachines', false), b('Kepler Communications', 'lever', 'kepler', false),
  b('Waabi', 'lever', 'waabi', false), b('Osaro', 'lever', 'osaro', false), b('Voltus', 'lever', 'voltus', false), b('Attabotics', 'lever', 'attabotics', false),
  // Ashby
  b('Skydio', 'ashby', 'skydio'), b('Saronic', 'ashby', 'saronic'), b('1X', 'ashby', '1x'), b('Antares', 'ashby', 'antares'),
  b('Gecko Robotics', 'ashby', 'gecko-robotics'), b('Physical Intelligence', 'ashby', 'physicalintelligence'),
  b('Picogrid', 'ashby', 'picogrid', false), b('Radiant', 'ashby', 'radiant'), b('Regent', 'ashby', 'regent'),
  b('Sanctuary AI', 'ashby', 'sanctuary', false), b('Salient Motion', 'ashby', 'salient', false), b('Pivotal', 'ashby', 'pivotal', false),
  // Workday (tenant|datacentre|site)
  b('NVIDIA', 'workday', 'nvidia|wd5|NVIDIAExternalCareerSite'), b('Boeing', 'workday', 'boeing|wd1|EXTERNAL_CAREERS'),
  b('General Motors', 'workday', 'generalmotors|wd5|Careers_GM'), b('Northrop Grumman', 'workday', 'ngc|wd1|Northrop_Grumman_External_Site'),
  b('RTX (Collins, Pratt & Whitney, Raytheon)', 'workday', 'globalhr|wd5|REC_RTX_Ext_Gateway'), b('GE Aerospace', 'workday', 'geaerospace|wd5|GE_ExternalSite'),
  b('GE Vernova', 'workday', 'gevernova|wd5|Vernova_ExternalSite'), b('GE HealthCare', 'workday', 'gehc|wd5|GEHC_ExternalSite'),
  b('Caterpillar', 'workday', 'cat|wd5|CaterpillarCareers'), b('3M', 'workday', '3m|wd1|Search'), b('Medtronic', 'workday', 'medtronic|wd1|MedtronicCareers'),
  b('Stryker', 'workday', 'stryker|wd1|StrykerCareers'), b('Applied Materials', 'workday', 'amat|wd1|External'), b('KLA', 'workday', 'kla|wd1|Search'),
  b('Micron', 'workday', 'micron|wd1|External'), b('Blue Origin', 'workday', 'blueorigin|wd5|BlueOrigin'),
  b('Boston Dynamics', 'workday', 'bostondynamics|wd1|Boston_Dynamics'), b('Magna', 'workday', 'magna|wd3|Magna'), b('CAE', 'workday', 'cae|wd3|career'),
  b('Analog Devices', 'workday', 'analogdevices|wd1|External'), b('HP', 'workday', 'hp|wd5|ExternalCareerSite'),
  b('Johnson Controls', 'workday', 'jci|wd5|JCI'), b('Carrier', 'workday', 'carrier|wd5|jobs'), b('Abbott', 'workday', 'abbott|wd5|abbottcareers'),
  b('Philips', 'workday', 'philips|wd3|jobs-and-careers'), b('Thermo Fisher', 'workday', 'thermofisher|wd5|ThermoFisherCareers'),
  b('Oshkosh', 'workday', 'oshkoshcorporation|wd5|Oshkosh'), b('Jabil', 'workday', 'jabil|wd5|Jabil_Careers'), b('ITW', 'workday', 'itw|wd5|External'),
  b('Rockwell Automation', 'workday', 'rockwellautomation|wd1|External_Rockwell_Automation'), b('Curtiss-Wright', 'workday', 'curtisswright|wd1|CW_External_Career_Site'),
  b('Woodward', 'workday', 'woodward|wd5|Woodward'), b('Xylem', 'workday', 'xylem|wd5|xylem-careers'), b('Danaher', 'workday', 'danaher|wd1|DanaherJobs'),
  b('Allegion', 'workday', 'allegion|wd5|careers'), b('Baxter', 'workday', 'baxter|wd1|baxter'), b('Leidos', 'workday', 'leidos|wd5|External'),
  b('Motorola Solutions', 'workday', 'motorolasolutions|wd5|Careers'), b('Ciena', 'workday', 'ciena|wd5|Careers'),
  b('Edwards Lifesciences', 'workday', 'edwards|wd5|EdwardsCareers'), b('Illumina', 'workday', 'illumina|wd1|illumina-careers'),
  b('DuPont', 'workday', 'dupont|wd5|Jobs'), b('Shell', 'workday', 'shell|wd3|ShellCareers'), b('Chevron', 'workday', 'chevron|wd5|jobs'),
  // Big tech with their own careers sites (Meta and Tesla refuse automated readers, so they are not here)
  b('Amazon', 'amazon', 'amazon'), b('Apple', 'apple', 'apple'), b('Google', 'google', 'google'),
  b('Microsoft', 'eightfold', 'apply.careers.microsoft.com|microsoft.com|pcsx'), b('Netflix', 'eightfold', 'explore.jobs.netflix.net|netflix.com|v2'),
  b('Ford', 'oracle', 'efds.fa.em5.oraclecloud.com|CX_1'), b('Honeywell', 'oracle', 'ibqbjb.fa.ocs.oraclecloud.com|CX_1'), b('Bosch', 'smartrecruiters', 'BoschGroup'),
  // AI labs and more large hardware employers
  b('OpenAI', 'ashby', 'openai'), b('Anthropic', 'greenhouse', 'anthropic'), b('xAI', 'greenhouse', 'xai'), b('Cerebras', 'ashby', 'cerebras'),
  b('Intel', 'workday', 'intel|wd1|External'), b('Qualcomm', 'workday', 'qualcomm|wd12|External'), b('Samsung', 'workday', 'sec|wd3|Samsung_Careers'),
  b('Cisco', 'workday', 'cisco|wd5|Cisco_Careers'), b('Broadcom', 'workday', 'broadcom|wd1|External_Career'), b('Marvell', 'workday', 'marvell|wd1|MarvellCareers'),
  b('GlobalFoundries', 'workday', 'globalfoundries|wd1|External'), b('Microchip', 'workday', 'microchiphr|wd5|External'), b('Logitech', 'workday', 'logitech|wd5|Logitech'),
  b('Aptiv', 'workday', 'aptiv|wd5|APTIV_CAREERS'), b('BorgWarner', 'workday', 'borgwarner|wd5|BorgWarner_Careers'), b('Baker Hughes', 'workday', 'bakerhughes|wd5|BakerHughes'),
  b('Dow', 'workday', 'dow|wd1|ExternalCareers'), b('BD', 'workday', 'bdx|wd1|EXTERNAL_CAREER_SITE_USA'), b('Dexcom', 'workday', 'dexcom|wd1|Dexcom'),
  b('Insulet', 'workday', 'insulet|wd5|insuletcareers'), b('ResMed', 'workday', 'resmed|wd3|ResMed_External_Careers'), b('Agilent', 'workday', 'agilent|wd5|Agilent_Careers'),
  b('Cognex', 'workday', 'cognex|wd1|External_Career_Site'), b('Trimble', 'workday', 'trimble|wd1|TrimbleCareers'), b('Sierra Space', 'workday', 'sierraspace|wd1|Sierra_Space_External_Career_Site'),
  b('Scout Motors', 'greenhouse', 'scoutmotors'), b('Wing', 'greenhouse', 'wing'), b('Planet Labs', 'greenhouse', 'planetlabs'), b('IonQ', 'greenhouse', 'ionq'),
  b('PsiQuantum', 'greenhouse', 'psiquantum'), b('Lightmatter', 'greenhouse', 'lightmatter'),
  // Y Combinator-backed hardware companies (alongside Relativity, Astranis, Oklo, Gecko Robotics, Heart Aerospace and Regent above)
  b('Boom Supersonic', 'ashby', 'boom'), b('Helion', 'ashby', 'helion'), b('Astro Mechanica', 'ashby', 'astro-mechanica'), b('Charge Robotics', 'ashby', 'charge-robotics'),
  b('Albedo', 'greenhouse', 'albedo'), b('Momentus', 'greenhouse', 'momentus'), b('Pyka', 'lever', 'pyka'), b('Mashgin', 'lever', 'mashgin'),
  // Other venture-backed hardware startups of some size
  b('Hadrian', 'ashby', 'hadrian-automation'), b('Base Power', 'ashby', 'base-power'), b('Bedrock Robotics', 'ashby', 'bedrock-robotics'), b('Dyna Robotics', 'ashby', 'dyna-robotics'),
  b('Standard Bots', 'ashby', 'standardbots'), b('Serve Robotics', 'ashby', 'serverobotics'), b('Reflect Orbital', 'ashby', 'reflect-orbital'), b('Periodic Labs', 'ashby', 'periodic-labs'),
  b('BRINC', 'ashby', 'brinc'), b('ICON', 'ashby', 'icon'), b('Slate Auto', 'ashby', 'slate'), b('Carbon Robotics', 'ashby', 'carbon-robotics'),
  b('Chaos Industries', 'greenhouse', 'chaosindustries'), b('Divergent', 'greenhouse', 'divergent'), b('Electra', 'greenhouse', 'electraaero'), b('Epirus', 'greenhouse', 'epirus'),
  b('Fervo Energy', 'greenhouse', 'fervoenergy'), b('Muon Space', 'greenhouse', 'muonspace'), b('Spire', 'greenhouse', 'spire'), b('Diligent Robotics', 'greenhouse', 'diligentrobotics'),
  b('Whisper Aero', 'greenhouse', 'whisperaero'), b('Group14', 'greenhouse', 'group14'), b('Hermeus', 'lever', 'hermeus'), b('Merlin Labs', 'lever', 'merlinlabs'),
  b('Ambi Robotics', 'lever', 'ambirobotics')
]
