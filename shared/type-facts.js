// Something interesting about each aircraft type — how it was designed, what it
// can do, or a piece of its history — shown on the card under the photo.
//
// Each entry is [type codes, facts]. A code can be in a family entry and in its
// own, more specific one; the card gets all of them and shows a different fact
// each time that type comes round. Keep each fact short enough to read from a
// few steps back (under 180 characters).
const FACTS = [
  // ---- Boeing ----------------------------------------------------------------
  [
    ['B712'],
    [
      'Born as the McDonnell Douglas MD-95, it was renamed the Boeing 717 after the two companies merged in 1997.',
      'The 717 is the last of a family of rear-engined jets that began with the Douglas DC-9 in 1965.',
    ],
  ],
  [
    ['B732', 'B733', 'B734', 'B735', 'B736', 'B737', 'B738', 'B739', 'B37M', 'B38M', 'B39M', 'B3XM', 'P8'],
    [
      'The 737 first flew in 1967 and has been in production ever since — the jet has been stretched, re-engined and re-winged several times.',
      'The 737 sits so low to the ground that baggage handlers can load it without belt loaders, which suited small airports in the 1960s.',
    ],
  ],
  [
    ['B732'],
    [
      'With a “gravel kit” fitted, the 737-200 can land on unpaved runways — it was a workhorse in Canada’s Arctic for decades.',
      'Its slim, cigar-shaped engine pods hang right under the wing: Pratt & Whitney JT8Ds, the same engine family as the DC-9 and 727.',
    ],
  ],
  [
    ['B733', 'B734', 'B735'],
    [
      'Its CFM56 engines were too big for the 737’s short landing gear, so the bottom of each engine pod was flattened — the “hamster pouch”.',
      'The 737-300, -400 and -500 “Classics” first flew in 1984 and brought the 737 its first high-bypass turbofans.',
    ],
  ],
  [
    ['B736', 'B737', 'B738', 'B739'],
    [
      'The Next Generation 737 got a new wing with 25% more area and 30% more fuel, letting it fly much further than the Classics.',
      'Those upturned wingtips are blended winglets, developed by Aviation Partners; they trim fuel burn by a few percent on longer flights.',
      'The Boeing Business Jet and the US Navy’s P-8 Poseidon submarine hunter are both built on the 737 Next Generation airframe.',
    ],
  ],
  [['B738'], ['The 737-800 is the most-built version of the 737, with nearly 5,000 delivered.']],
  [
    ['B37M', 'B38M', 'B39M', 'B3XM'],
    [
      'Its LEAP-1B engines are so large that they sit further forward and higher on the wing, and the nose gear was lengthened by 20 cm (8 in).',
      'Look for the split-tip winglets that point both up and down, and the saw-toothed “chevrons” on the back of the engines that cut noise.',
      'The 737 MAX was grounded worldwide from March 2019 to late 2020 after two crashes traced to its MCAS flight-control software.',
    ],
  ],
  [
    ['B741', 'B742', 'B743', 'B744', 'B748', 'B74S', 'BLCF'],
    [
      'The 747’s hump exists because it was designed to become a freighter: the cockpit sits upstairs so the whole nose can swing up for cargo.',
      'Pan Am flew the first 747 passenger service in January 1970. Its wide cabin earned it the name “Jumbo Jet”.',
      'Boeing built a new factory in Everett, Washington for the 747 — still the largest building in the world by volume.',
    ],
  ],
  [
    ['B744'],
    [
      'The 747-400 added 1.8 m (6 ft) winglets and a two-pilot glass cockpit, doing away with the flight engineer.',
      'Freighter 747-400Fs have a nose door that swings upward, so pallets and even whole jet engines can be rolled straight in.',
    ],
  ],
  [
    ['B748'],
    [
      'At 76.3 m (250 ft), the 747-8 was the longest airliner ever built when it first flew in 2010.',
      'Its GEnx engines and swept-back “raked” wingtips were borrowed from the 787 Dreamliner.',
      'The last of 1,574 747s, a 747-8 freighter, was delivered to Atlas Air in January 2023 after 54 years of production.',
    ],
  ],
  [
    ['B74S'],
    [
      'The 747SP is 14 m (47 ft) shorter than a standard 747, with a taller tail — built to fly further, such as New York to Tokyo nonstop.',
      'Only 45 747SPs were built. NASA flew one as SOFIA, an airborne observatory with a 2.7 m telescope in its side.',
    ],
  ],
  [
    ['BLCF'],
    [
      'Only four Dreamlifters were built, to fly 787 wings and fuselage sections from suppliers in Japan and Italy to Boeing’s plants.',
      'The whole tail section of the Dreamlifter swings sideways on hinges to load cargo — the largest cargo hold of any aircraft when it flew.',
    ],
  ],
  [
    ['B752', 'B753'],
    [
      'Famously overpowered, the 757 can use short or high-altitude runways that ground larger jets — one reason airlines still fly them.',
      '1,049 757s were built before production ended in 2004. The US Air Force flies it as the C-32, the Vice President’s Air Force Two.',
    ],
  ],
  [['B753'], ['At 54.5 m (179 ft), the 757-300 is the longest single-aisle twin-engine jet ever built.']],
  [
    ['B762', 'B763', 'B764'],
    [
      'In 1983 an Air Canada 767 ran out of fuel after a metric-conversion mix-up and glided to a safe landing at Gimli, Manitoba — the “Gimli Glider”.',
      'The 767 was the first twin-jet to fly routine transatlantic passenger service under ETOPS rules, starting in 1985.',
      'The 767 freighter and the KC-46 tanker kept the 767 line running long after airlines stopped ordering the passenger version.',
    ],
  ],
  [
    ['B772', 'B77L', 'B773', 'B77W'],
    [
      'The 777 was the first airliner designed entirely on computer — Boeing never built a full-size mock-up.',
      'Each main landing gear has six wheels on a three-axle bogie, an easy way to spot a 777 from below.',
      'The 777 was Boeing’s first fly-by-wire airliner, with computers between the pilots’ controls and the control surfaces.',
    ],
  ],
  [
    ['B77L', 'B77W'],
    [
      'Its GE90-115B engines are among the most powerful jet engines ever made; each fan is 3.25 m (128 in) across.',
      'In 2005 a 777-200LR flew 21,602 km nonstop from Hong Kong to London the long way round, a distance record for airliners at the time.',
    ],
  ],
  [
    ['B778', 'B779'],
    [
      'The 777X’s carbon-fibre wing spans 72 m (235 ft), so the last 3.5 m of each wingtip folds up on the ground to fit standard airport gates.',
      'Its GE9X engines have the largest fans of any jet engine: 3.4 m (134 in) across.',
    ],
  ],
  [
    ['B788', 'B789', 'B78X'],
    [
      'About half of the 787 by weight is carbon-fibre composite, including its fuselage, built as one-piece barrels instead of riveted panels.',
      'The 787 has the largest windows of any airliner and no shades: passengers dim them electronically.',
      'Its cabin is pressurised to the equivalent of 1,800 m (6,000 ft) instead of the usual 2,400 m (8,000 ft), so passengers arrive less tired.',
      'Look for the saw-toothed edges on the back of the engines and the long, flexible wings that curve upward in flight.',
    ],
  ],

  // ---- Airbus ----------------------------------------------------------------
  [
    ['BCS1', 'BCS3'],
    [
      'The A220 was designed in Canada as the Bombardier CSeries and built in Mirabel, Quebec; Airbus took it over and renamed it in 2018.',
      'Its Pratt & Whitney geared turbofans use a gearbox so the big fan can turn slower than the turbine, cutting fuel use and noise.',
      'With just five seats per row (2-3), the A220 has some of the widest economy seats on any single-aisle jet.',
    ],
  ],
  [
    ['A318'],
    [
      'The “Baby Bus” is the smallest Airbus airliner. British Airways flew all-business-class A318s from London City Airport to New York.',
      'The A318 is certified for steep 5.5° approaches, like the one into London City, where most jets of its size can’t go.',
    ],
  ],
  [
    ['A318', 'A319', 'A320', 'A321', 'A19N', 'A20N', 'A21N'],
    [
      'The A320 was the first airliner with digital fly-by-wire controls, and has side-sticks in place of the traditional control column.',
      'Flight-envelope protection on the A320 family stops pilots from stalling or overstressing the jet, however hard they pull the stick.',
      'Every A320 family jet shares the same cockpit and type rating, so one pilot can fly all of them — from the A318 to the A321.',
    ],
  ],
  [
    ['A319'],
    [
      'The A319 is 3.7 m (12 ft) shorter than an A320 but has the same wing, so it handles hot, high-altitude airports well.',
      'Many government and corporate jets are A319s: the Airbus Corporate Jet version can fly over 11,000 km with extra fuel tanks.',
    ],
  ],
  [
    ['A320'],
    [
      'US Airways Flight 1549, the 2009 “Miracle on the Hudson”, was an A320 that ditched in the river after hitting geese — everyone survived.',
    ],
  ],
  [
    ['A321'],
    [
      'The A321 is the longest of the original A320 family, 6.9 m (23 ft) longer than an A320, with double-slotted flaps to carry the extra weight.',
    ],
  ],
  [
    ['A19N', 'A20N', 'A21N'],
    [
      '“neo” means New Engine Option: a choice of CFM LEAP-1A or Pratt & Whitney geared turbofans, burning about 15–20% less fuel than before.',
      'The tall, curved wingtips are what Airbus calls “Sharklets”.',
    ],
  ],
  [
    ['A21N'],
    [
      'The long-range A321XLR can fly about 8,700 km (4,700 nmi) — enough to cross the Atlantic in a single-aisle jet.',
      'Some A321neos have extra exit doors over the wing; the “Cabin Flex” layout lets airlines seat up to 244 passengers.',
    ],
  ],
  [
    ['A306', 'A30B'],
    [
      'The A300 was Airbus’s first airliner, flying in 1972, and the world’s first twin-engine widebody.',
      'Most A300s still flying today are freighters, carrying parcels overnight for companies like UPS and FedEx.',
    ],
  ],
  [
    ['A310'],
    [
      'A shortened A300 with a new wing, the A310 introduced the small wingtip fences that Airbus later fitted to the A320.',
    ],
  ],
  [
    ['A332', 'A333', 'A338', 'A339'],
    [
      'The A330 and the four-engined A340 were developed side by side and share the same wing, cockpit and fuselage.',
      'In 2001 Air Transat Flight 236, an A330, lost both engines over the Atlantic and glided about 120 km to the Azores — a record airliner glide.',
      'Air forces fly the A330 as the MRTT tanker, refuelling other aircraft through a boom or hoses trailed from the wings.',
    ],
  ],
  [
    ['A338', 'A339'],
    [
      'The A330neo got Rolls-Royce Trent 7000 engines and a wing stretched by 3.7 m to 64 m (210 ft), with curved Sharklet tips.',
    ],
  ],
  [
    ['A342', 'A343', 'A345', 'A346'],
    [
      'Four engines let the A340 fly long routes over oceans before rules for twin-engined jets were relaxed.',
      'At 75.4 m (247 ft), the A340-600 was the world’s longest airliner from 2002 until the 747-8 came along.',
      'Look under the belly: the A340 has an extra main landing gear leg on the centreline.',
    ],
  ],
  [
    ['A359', 'A35K'],
    [
      'More than half of the A350’s structure is carbon-fibre and other composites.',
      'Its flaps move in flight to reshape the wing for the best efficiency as fuel burns off — the wing “morphs”.',
      'The black “raccoon mask” around the A350’s cockpit windows is a styling choice — and makes it easy to spot.',
      'Its wingtips curl smoothly upward instead of ending in a separate winglet.',
    ],
  ],
  [['A35K'], ['The A350-1000 is the largest twin-engine jet Airbus has built, 73.8 m (242 ft) long.']],
  [
    ['A388'],
    [
      'The A380 is the largest passenger airliner ever built, with two full-length decks and a wingspan of 79.8 m (262 ft).',
      'Production ended in 2021 after 251 A380s; the last went to Emirates, which flies about half of all A380s ever built.',
      'Its wing is huge for its weight because it was sized for a longer A380 that was never built.',
    ],
  ],
  [
    ['A3ST'],
    [
      'The Beluga is an A300 with a giant bulging upper fuselage, built to carry Airbus wings and fuselage sections between European factories.',
    ],
  ],
  [
    ['A400'],
    [
      'Each of the A400M’s four TP400 turboprops makes about 11,000 hp; the two propellers on each wing turn in opposite directions.',
    ],
  ],

  // ---- Embraer ---------------------------------------------------------------
  [
    ['E135', 'E145', 'E45X'],
    [
      'The ERJ family stretched the cabin of Embraer’s Brasília turboprop and added tail-mounted jets, giving three seats per row (1-2).',
    ],
  ],
  [
    ['E170', 'E75S', 'E75L', 'E190', 'E195', 'E290', 'E295'],
    ['Embraer’s E-Jets have a “double-bubble” fuselage that seats four abreast — no middle seats.'],
  ],
  [
    ['E75S', 'E75L'],
    [
      'Pilot contracts at the big US airlines limit regional jets to 76 seats, so the E175 is built to fit those rules exactly.',
    ],
  ],
  [
    ['E290', 'E295'],
    [
      'The E2 got a new, longer wing and geared turbofans. Embraer painted its demonstrators’ noses as “Profit Hunters”: a shark, eagle and tiger.',
      'The E195-E2 is the largest airliner Embraer has built, with up to 146 seats.',
    ],
  ],
  [['E50P'], ['The Phenom 100 is a “very light jet” that one pilot can fly, carrying four to six passengers.']],
  [['E55P'], ['The Phenom 300 has been the world’s best-selling light business jet for more than a decade.']],
  [
    ['E545', 'E550'],
    [
      'The Praetors have full fly-by-wire with turbulence reduction: sensors sense a bump and move the controls to smooth it out.',
    ],
  ],
  [['E35L'], ['The Legacy 600 is an ERJ 135 regional airliner turned business jet, with extra fuel tanks for range.']],

  // ---- Bombardier / Canadair / Learjet ---------------------------------------
  [
    ['CRJ1', 'CRJ2'],
    [
      'The CRJ grew out of the Canadair Challenger business jet, stretched to seat 50. It first flew in 1991, built in Montreal.',
    ],
  ],
  [
    ['CRJ1', 'CRJ2', 'CRJ7', 'CRJ9', 'CRJX'],
    [
      'More than 1,900 CRJs were built before production ended; Mitsubishi bought the program in 2020 and supports the fleet.',
    ],
  ],
  [
    ['CRJ7', 'CRJ9', 'CRJX'],
    [
      'The CRJ700, 900 and 1000 are stretched CRJs with a new wing with leading-edge slats and a lowered cabin floor for more headroom.',
    ],
  ],
  [
    ['CL30', 'CL35'],
    [
      'The Challenger 300 and 350 can fly across North America nonstop — about 5,900 km (3,200 nmi) — and are best-sellers in their class.',
    ],
  ],
  [
    ['CL60'],
    [
      'The Challenger 600 was conceived by Bill Lear and finished by Canadair; its wide cabin later became the CRJ airliner’s fuselage.',
    ],
  ],
  [
    ['GLEX', 'GL5T'],
    [
      'The Global Express was one of the first business jets able to fly about 11,000 km (6,000 nmi) nonstop, such as New York to Tokyo.',
      'Air forces use Globals as spy planes and flying relay stations, like the US Air Force’s E-11A.',
    ],
  ],
  [
    ['GL7T'],
    [
      'With a range of 14,260 km (7,700 nmi), the Global 7500 had the longest range of any business jet when it entered service in 2018.',
      'Its cabin is split into four separate living spaces, including a full bedroom.',
    ],
  ],
  [
    ['LJ35', 'LJ40', 'LJ45', 'LJ60', 'LJ75'],
    [
      'Bill Lear’s original Learjet 23 of 1963 was based on a Swiss fighter-bomber design, the P-16.',
      'Learjet production ended in 2021, after about 3,000 had been built since 1963.',
    ],
  ],

  // ---- De Havilland Canada and other regional turboprops ----------------------
  [
    ['DH8A', 'DH8B', 'DH8C', 'DH8D'],
    [
      'The Dash 8 was designed and built in Downsview, Toronto. Its high wing keeps the propellers clear of gravel and snow on rough strips.',
    ],
  ],
  [
    ['DH8D'],
    [
      'The Q400 is one of the fastest turboprop airliners, cruising at up to 667 km/h (360 kt) — close to regional-jet times on short routes.',
      'The “Q” stands for quiet: speakers and actuators in the cabin cancel propeller noise and vibration.',
    ],
  ],
  [
    ['DHC6'],
    [
      'The Twin Otter flies on wheels, skis or floats, and is the workhorse of polar research stations in the Arctic and Antarctica.',
      'Production stopped in 1988 and restarted in Calgary in 2008 with the Series 400 — a rare second life for an aircraft design.',
    ],
  ],
  [
    ['DHC7'],
    [
      'Four engines and huge flaps let the Dash 7 use very short runways; it flew the first services from London City Airport in 1987.',
    ],
  ],
  [
    ['DHC2'],
    [
      'The Beaver was named one of Canada’s top ten engineering achievements of the 20th century; floatplane Beavers still fly daily in BC.',
      'In 2019 Harbour Air flew the world’s first all-electric commercial aircraft — a converted Beaver — off Vancouver.',
    ],
  ],
  [
    ['DHC3'],
    ['The Otter is a bigger Beaver: a single-engine bush plane that carries about ten people, often on floats.'],
  ],
  [
    ['AT43', 'AT45', 'AT46', 'AT72', 'AT75', 'AT76'],
    [
      'ATR stands for Avions de Transport Régional, a joint venture of Airbus and Italy’s Leonardo that builds its planes in Toulouse.',
      'ATRs can run the right engine with its propeller braked (“Hotel mode”) to power the plane on the ground without a separate APU.',
    ],
  ],
  [['AT43', 'AT45', 'AT46'], ['Many ATR 42s now fly as freighters, and some are fitted to land on gravel runways.']],
  [
    ['SF34'],
    ['The Saab 340 was the Swedish car and jet-fighter maker’s first airliner, developed with Fairchild in the 1980s.'],
  ],
  [
    ['SB20'],
    [
      'The Saab 2000 is one of the fastest turboprop airliners, cruising at about 665 km/h, with active cabin noise cancelling.',
    ],
  ],
  [
    ['B190'],
    [
      'The Beech 1900D’s raised roof lets passengers stand up — rare in a 19-seater. Look for the small extra fins on its tail and rear fuselage.',
    ],
  ],

  // ---- McDonnell Douglas -----------------------------------------------------
  [
    ['MD11'],
    [
      'KLM flew the last MD-11 passenger flight in 2014; since then MD-11s have flown only as freighters.',
      'The MD-11 is a stretched DC-10 with winglets and a two-pilot glass cockpit, doing away with the flight engineer.',
    ],
  ],
  [
    ['MD82', 'MD83', 'MD88', 'MD90'],
    ['Nicknamed the “Mad Dog”, the MD-80 is a stretched DC-9 with rear engines and five seats per row.'],
  ],
  [['MD90'], ['The MD-90 swapped in IAE V2500 engines — the same engines as on many Airbus A320s.']],
  [
    ['DC10'],
    [
      'The DC-10’s third engine is mounted high, right through the base of its tail fin.',
      'Converted DC-10 air tankers drop about 35,000 litres (9,400 US gal) of fire retardant in a single run.',
    ],
  ],

  // ---- Business jets ---------------------------------------------------------
  [
    ['C25A', 'C25B', 'C25C', 'C25M', 'C525', 'C510', 'C550', 'C55B', 'C560', 'C56X', 'C680', 'C68A', 'C700', 'C750'],
    ['Cessna’s Citations are the best-selling line of business jets ever, with more than 7,000 built since 1972.'],
  ],
  [
    ['C25A', 'C25B', 'C25C', 'C25M', 'C525'],
    ['The CitationJet family is certified for a single pilot, so many are flown by their owners.'],
  ],
  [
    ['C510'],
    ['The Citation Mustang is Cessna’s smallest jet, a single-pilot “very light jet” with four passenger seats.'],
  ],
  [
    ['C550', 'C55B', 'C560'],
    [
      'Early straight-winged Citations were gentle and good on short runways, but so slow that rival pilots called them “Slowtations”.',
    ],
  ],
  [
    ['C56X'],
    [
      'The Citation Excel paired a shortened Citation X fuselage, with stand-up headroom, with the Citation V’s straight wing.',
    ],
  ],
  [
    ['C680'],
    ['The Citation Sovereign is built for short runways: it can carry a full cabin out of strips around 1,100 m long.'],
  ],
  [['C68A'], ['The Citation Latitude has a flat-floored cabin 1.83 m (6 ft) tall — stand-up room in a mid-size jet.']],
  [
    ['C700'],
    [
      'The Citation Longitude can fly 6,500 km (3,500 nmi), coast to coast across North America with passengers aboard.',
    ],
  ],
  [
    ['C750'],
    [
      'Cruising at up to Mach 0.935, the Citation X was the fastest civil aircraft in the world after Concorde retired.',
    ],
  ],
  [
    ['GLF4', 'GLF5', 'GLF6', 'G280', 'GA5C', 'GA6C', 'GA7C', 'GA8C'],
    ['Big oval cabin windows are a Gulfstream trademark — you can spot one from the ground by them.'],
  ],
  [
    ['GLF4'],
    ['Militaries fly the Gulfstream IV as the C-20 VIP transport, and NOAA uses one to fly into and above hurricanes.'],
  ],
  [
    ['GLF5'],
    [
      'The Gulfstream V was the first business jet able to fly 12,000 km (6,500 nmi); the US Air Force flies it as the C-37.',
    ],
  ],
  [['GLF6'], ['The G650 can reach Mach 0.925 — among the fastest business jets — and fly 13,000 km (7,000 nmi).']],
  [['G280'], ['The G280 was designed and is built with Israel Aerospace Industries.']],
  [
    ['GA5C', 'GA6C'],
    [
      'The G500 and G600 were the first business jets with active-control side-sticks, linked so each pilot feels what the other is doing.',
    ],
  ],
  [['GA7C'], ['The G700 has 20 extra-large oval windows and a range of 14,350 km (7,750 nmi).']],
  [['GA8C'], ['With a range of 14,800 km (8,000 nmi), the G800 is the longest-flying Gulfstream.']],
  [
    ['FA50', 'F900', 'F2TH', 'FA7X', 'FA8X', 'FA6X'],
    [
      'Dassault also builds the Rafale fighter jet, and brings know-how from its military jets to the Falcon business jets.',
    ],
  ],
  [
    ['FA50', 'F900', 'FA7X', 'FA8X'],
    ['Three engines let these Falcons fly long routes over oceans and mountains with an extra margin of safety.'],
  ],
  [
    ['FA7X', 'FA8X'],
    ['The Falcon 7X was the first fly-by-wire business jet, with flight controls derived from the Rafale fighter.'],
  ],
  [['FA6X'], ['Dassault says the Falcon 6X has the tallest and widest cabin of any purpose-built business jet.']],
  [
    ['HDJT'],
    [
      'The HondaJet’s engines sit on pylons above the wings, which frees cabin space and reduces drag. It was Honda’s first aircraft.',
    ],
  ],
  [
    ['H25B'],
    ['The Hawker 800 descends from the 1962 de Havilland DH.125; the RAF used it to train navigators as the Dominie.'],
  ],
  [
    ['BE40'],
    [
      'The Beechjet began life as the Mitsubishi Diamond; the US Air Force trains its transport pilots on it as the T-1 Jayhawk.',
    ],
  ],
  [
    ['PRM1'],
    [
      'The Premier I’s fuselage is made of carbon fibre laid down by machine over a mould, making it light and roomy for its size.',
    ],
  ],
  [
    ['PC24'],
    [
      'The Pilatus PC-24 was the first business jet designed to land on gravel and grass, and has a big cargo door for bulky loads.',
    ],
  ],
  [
    ['SF50'],
    [
      'The Vision Jet is a single-engine personal jet with a parachute for the whole aircraft, and a button that can land it automatically.',
    ],
  ],

  // ---- Utility turboprops ----------------------------------------------------
  [
    ['PC12'],
    [
      'A single-engine turboprop that can use short gravel strips, the PC-12 flies with Australia’s Royal Flying Doctor Service.',
    ],
  ],
  [
    ['PC6T'],
    [
      'In 1960 a Pilatus Porter landed on a glacier on Nepal’s Dhaulagiri at 5,750 m — a record for a fixed-wing aircraft.',
    ],
  ],
  [
    ['C208'],
    [
      'The Caravan carries about a dozen people or more than a tonne of freight; FedEx flies hundreds as feeder planes to small towns.',
      'Caravans fly on wheels, floats or skis, and serve as small airliners, skydiving planes and bush planes.',
    ],
  ],
  [
    ['TBM7', 'TBM8', 'TBM9'],
    ['A single-engine turboprop that cruises at up to about 610 km/h (330 kt) — as fast as some light jets.'],
  ],
  [
    ['BE9L', 'BE10', 'BE20', 'BE30', 'B350'],
    [
      'The King Air has been in production since 1964 — longer than any other business turboprop — with more than 7,500 built.',
      'King Airs serve as air ambulances, survey planes and military transports; the US Army calls them C-12 Hurons.',
    ],
  ],
  [
    ['BE20', 'BE30', 'B350'],
    [
      'The Super King Air is easy to tell from the original by its T-tail, with the tailplane mounted on top of the fin.',
    ],
  ],
  [
    ['P46T'],
    [
      'The Piper M600 was one of the first aircraft with Garmin Autoland: one button lands the plane by itself if the pilot is incapacitated.',
    ],
  ],
  [
    ['P180'],
    [
      'The Piaggio Avanti has pusher propellers behind the wing and a small front wing; it cruises at up to 740 km/h, among the fastest turboprops.',
    ],
  ],
  [
    ['AT3P', 'AT5T'],
    [
      'Air Tractors are purpose-built crop sprayers; the model number hints at the hopper size — an AT-502 carries about 500 US gallons.',
      'Firefighting versions of the Air Tractor, like the Fire Boss on floats, can scoop water from a lake without landing.',
    ],
  ],

  // ---- Light aircraft --------------------------------------------------------
  [
    ['C150', 'C152'],
    ['More than 30,000 Cessna 150s and 152s were built — a huge number of pilots learned to fly in one.'],
  ],
  [
    ['C162'],
    [
      'The Skycatcher was a two-seat light-sport trainer built in China; Cessna ended production in 2013 after weak sales.',
    ],
  ],
  [
    ['C170'],
    [
      'The Cessna 170 is the tailwheel ancestor of the 172 — the same four-seat cabin, but with the small wheel at the back.',
    ],
  ],
  [
    ['C172'],
    [
      'The Cessna 172 is the most-produced aircraft in history, with more than 45,000 built since 1956.',
      'In 1958–59 a Cessna 172 stayed aloft for 64 days, refuelling from a truck racing beneath it — still the endurance record.',
    ],
  ],
  [['C177'], ['The Cardinal has no wing struts — its cantilever wing gives a clear view out of the cabin.']],
  [
    ['C180', 'C185'],
    [
      'In 1964 Jerrie Mock became the first woman to fly solo around the world, in a Cessna 180 named “Spirit of Columbus”.',
      'Tailwheel Skywagons are a favourite bush plane, often flown on floats or skis.',
    ],
  ],
  [
    ['C182', 'C82R'],
    ['The Skylane is the 172’s bigger brother, with a stronger engine; more than 23,000 have been built since 1956.'],
  ],
  [['C82R'], ['The Skylane RG folds its wheels into the fuselage in flight for extra speed.']],
  [
    ['C206', 'T206', 'C207'],
    [
      'A workhorse six-seater with wide double cargo doors on the right side — a popular floatplane and skydiving plane.',
    ],
  ],
  [['C210'], ['The Centurion folds its wheels up into the fuselage in flight, and most have no wing struts.']],
  [['C310'], ['A Cessna 310 named “Songbird” starred alongside its pilot in the 1950s TV show Sky King.']],
  [
    ['C340', 'C414', 'C421'],
    ['A pressurised piston twin, so passengers can cruise above the weather without oxygen masks.'],
  ],
  [['C402'], ['The Cessna 402 is a ten-seat commuter twin; Cape Air flew a big fleet of them around New England.']],
  [
    ['SR20', 'SR22', 'S22T'],
    [
      'Every Cirrus has a parachute that can lower the whole aircraft to the ground; it has saved well over 100 lives.',
      'Cirrus planes are built from composites, with a side-yoke instead of a control wheel and big screens instead of round dials.',
    ],
  ],
  [
    ['P28A', 'P28B', 'P28R'],
    [
      'The Cherokee was designed to be cheap to build, with few parts, to take on the Cessna 172; more than 32,000 PA-28s have been built.',
    ],
  ],
  [
    ['P28R'],
    [
      'The Arrow is the Cherokee with retractable landing gear — and a system that can lower the wheels automatically if the pilot forgets.',
    ],
  ],
  [['P32R', 'PA32'], ['A stretched Cherokee with six seats and a big rear double door for loading bags or cargo.']],
  [
    ['PA34', 'PA44'],
    [
      'Its propellers turn in opposite directions, so the plane handles the same whichever engine fails — popular for twin-engine training.',
    ],
  ],
  [['PA46'], ['The Malibu is a pressurised six-seat single — the cabin stays comfortable at up to 25,000 ft.']],
  [['PA18'], ['With big “tundra tires”, a Super Cub can land on gravel bars and riverbanks a few dozen metres long.']],
  [
    ['PA24', 'PA30'],
    [
      'Comanche production ended in 1972 when Hurricane Agnes flooded Piper’s factory in Lock Haven, Pennsylvania and destroyed its tooling.',
    ],
  ],
  [['PA31'], ['The Navajo was a workhorse of small commuter airlines, with eight to ten seats and an airstair door.']],
  [['PA27'], ['The US Navy flew the Piper Aztec as the U-11A utility transport.']],
  [
    ['BE33', 'BE35', 'BE36', 'BT36'],
    ['The Bonanza has been in production since 1947 — the longest production run of any aircraft.'],
  ],
  [
    ['BE35'],
    [
      'The classic V-tail Bonanza has just two tail surfaces, “ruddervators”, that do the job of both rudder and elevator.',
    ],
  ],
  [['BE55', 'BE58'], ['The Baron, a twin-engined cousin of the Bonanza, has been built since 1961.']],
  [['BE60'], ['Pressurised and turbocharged, the Beech Duke can cruise above 25,000 ft — high for a piston twin.']],
  [
    ['DA40', 'DV20', 'DA42', 'DA62'],
    [
      'Diamond builds aircraft in London, Ontario, as well as in Austria; their composite airframes have a strong safety record.',
    ],
  ],
  [
    ['DA42', 'DA62'],
    ['Its diesel-cycle engines burn jet fuel, which is cheaper and easier to find than avgas in much of the world.'],
  ],
  [
    ['M20P', 'M20T'],
    [
      'Mooneys are known for speed on little power, and for a tail whose fin looks swept forward — it’s actually vertical.',
    ],
  ],
  [
    ['RV4', 'RV6', 'RV7', 'RV8', 'RV9', 'RV10', 'RV12', 'RV14'],
    [
      'Van’s RVs are built from kits by their owners — more than 10,000 have flown, making them the most popular kit planes ever.',
    ],
  ],
  [['HUSK'], ['The Husky is a tandem-seat bush plane built in Afton, Wyoming, often on big tires or floats.']],
  [
    ['A5'],
    ['The ICON A5 is an amphibious light-sport plane whose wings fold back so it can be towed home on a trailer.'],
  ],
  [['CH7A'], ['The Champ is a two-seat tandem trainer from 1945; thousands taught a post-war generation to fly.']],
  [
    ['COL3'],
    [
      'The Columbia 300 began as the Lancair kit plane; Cessna later bought the design and sold it as the Cessna 350 Corvalis.',
    ],
  ],

  // ---- Helicopters -----------------------------------------------------------
  [['R22'], ['The two-seat Robinson R22 is one of the world’s most common training helicopters.']],
  [['R44'], ['The four-seat R44 has been one of the best-selling civil helicopters in the world for decades.']],
  [['R66'], ['The R66 is Robinson’s first turbine helicopter, with a baggage compartment built into the fuselage.']],
  [
    ['EC20', 'EC30', 'EC35', 'EC55', 'AS65', 'H160'],
    ['Its tail rotor is a Fenestron — a fan spinning inside the tail fin, quieter and safer for people on the ground.'],
  ],
  [
    ['EC30'],
    ['The EC130 was developed with Grand Canyon tour operators: a wide cabin and big windows for sightseeing.'],
  ],
  [['EC35'], ['The H135 is one of the most common air-ambulance and police helicopters in the world.']],
  [
    ['EC45', 'BK17'],
    [
      'The BK 117 was a joint project of Germany’s MBB and Japan’s Kawasaki in the 1970s; the H145 is its modern descendant.',
      'Clamshell doors at the back let a stretcher slide straight in, making it a favourite air ambulance — including STARS in western Canada.',
    ],
  ],
  [
    ['AS50', 'AS55'],
    ['In 2005 an AS350 B3 landed on the summit of Mount Everest, 8,848 m up — the highest helicopter landing ever.'],
  ],
  [['AS65'], ['The US Coast Guard flies the Dauphin as the MH-65 Dolphin rescue helicopter.']],
  [['H160'], ['The H160’s “Blue Edge” rotor blades have a double-swept tip that quietens the slap of the blades.']],
  [
    ['A109'],
    ['The AW109 tucks its wheels up in flight, which makes it one of the fastest light twin-engine helicopters.'],
  ],
  [
    ['A139'],
    ['The AW139 is the world’s best-selling medium twin-engine helicopter; Ontario’s Ornge air ambulance flies them.'],
  ],
  [
    ['A169'],
    ['The AW169 sits between the AW109 and AW139 in Leonardo’s family, and is widely flown as an air ambulance.'],
  ],
  [
    ['B06', 'B06T'],
    [
      'The JetRanger set the standard for light turbine helicopters; Bell built them in Mirabel, Quebec, from 1986.',
      'In 1982 a Bell 206 LongRanger made the first round-the-world helicopter flight.',
    ],
  ],
  [['B407', 'B429', 'B505'], ['Built by Bell in Mirabel, Quebec.']],
  [
    ['B407'],
    [
      'The Bell 407 is a JetRanger family helicopter with a four-blade composite rotor derived from the military OH-58D.',
    ],
  ],
  [['B412'], ['The Canadian Armed Forces fly the Bell 412 as the CH-146 Griffon.']],
  [
    ['B505'],
    [
      'The Bell 505 Jet Ranger X has a flat-floored cabin and wide windows, designed with input from operators worldwide.',
    ],
  ],
  [
    ['S76'],
    [
      'The S-76 was designed to fly oil workers to offshore platforms, and has served as a royal and presidential helicopter.',
    ],
  ],
  [
    ['H60'],
    ['The Black Hawk entered US Army service in 1979; more than 4,000 have been built for dozens of countries.'],
  ],
  [
    ['MD52', 'MD60'],
    [
      'These MD helicopters have no tail rotor: NOTAR blows air out of slots in the tail boom and a steerable vent at the end.',
    ],
  ],

  // ---- Military --------------------------------------------------------------
  [
    ['C17'],
    [
      'The C-17 can land 77 tonnes of cargo on a dirt runway just 1,060 m (3,500 ft) long, and back up on its own using reverse thrust.',
      'The Royal Canadian Air Force flies five C-17s, which it calls the CC-177 Globemaster III.',
    ],
  ],
  [
    ['C5M'],
    [
      'The C-5 Galaxy is one of the largest military aircraft; its nose and tail both open so vehicles drive straight through.',
    ],
  ],
  [
    ['C130', 'C30J'],
    [
      'The Hercules has been in production since 1954, longer than any other military aircraft.',
      'In 1963 a C-130 landed on and took off from the aircraft carrier USS Forrestal — the largest plane ever to do so.',
    ],
  ],
  [
    ['C30J'],
    ['The C-130J’s six-blade composite propellers and new engines give it about 40% more range than older Hercules.'],
  ],
  [
    ['K35R'],
    ['KC-135 tankers were built between 1955 and 1965; many are expected to fly until they’re over 80 years old.'],
  ],
  [['E3TF'], ['The E-3 Sentry’s rotating radar dome is 9 m (30 ft) across and turns six times a minute.']],
  [
    ['P8'],
    ['The P-8 Poseidon is a 737 sub-hunter that drops sonobuoys and torpedoes from a bomb bay behind its wing.'],
  ],
  [
    ['B52'],
    [
      'The last B-52 was built in 1962, yet the US Air Force plans to keep it flying into the 2050s — nearly a century of service.',
    ],
  ],
  [
    ['V22'],
    ['The V-22 Osprey tilts its rotors upward to take off like a helicopter, then forward to fly like a plane.'],
  ],
  [
    ['F16'],
    [
      'The F-16 has a frameless bubble canopy and a side-stick, and was the first fighter with fly-by-wire controls designed in.',
    ],
  ],
  [
    ['F18H'],
    ['The Royal Canadian Air Force flies the Hornet as the CF-18; it has defended Canadian skies since 1982.'],
  ],
  [
    ['F18S'],
    ['The Super Hornet is about 20% larger than the original Hornet, with distinctive rectangular air intakes.'],
  ],
  [
    ['F35'],
    [
      'Canada is buying F-35s to replace its CF-18 Hornets; the F-35B version can take off from short decks and land vertically.',
    ],
  ],
  [
    ['T38'],
    [
      'The supersonic T-38 has trained military pilots since 1961, and NASA astronauts fly them to keep their skills sharp.',
    ],
  ],
  [
    ['AJET'],
    [
      'Top Aces in Canada flies ex-German Alpha Jets as “adversary” aircraft, playing the enemy in fighter-pilot training.',
      'The Franco-German Alpha Jet is still flown by the Patrouille de France aerobatic team.',
    ],
  ],

  // ---- Odds and ends ---------------------------------------------------------
  [
    ['GLID'],
    [
      'Gliders stay up by riding rising air; the distance record for a single glider flight is over 3,000 km, set in the Andes in 2003.',
    ],
  ],
  [['BALL'], ['The first people to fly went up in a Montgolfier hot-air balloon in Paris in 1783.']],
];

const BY_CODE = new Map();
for (const [codes, facts] of FACTS) {
  for (const code of codes) BY_CODE.set(code, [...(BY_CODE.get(code) ?? []), ...facts]);
}

/** Interesting facts about an ICAO aircraft type ("B38M"), or [] when there are none. */
export function typeFacts(code) {
  return (code && BY_CODE.get(code.toUpperCase())) || [];
}

/** Every type code that has facts (for tests). */
export const FACT_CODES = [...BY_CODE.keys()];
