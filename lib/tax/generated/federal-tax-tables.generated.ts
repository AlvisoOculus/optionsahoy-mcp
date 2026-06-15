// AlphaLatitude Inc. © 2026
//
// GENERATED FILE - DO NOT EDIT.
// Source of record: the main app's backend/src/calculations/taxTables.js
// (year-keyed federal tax constants, cross-checked against the IRS publications).
// Regenerate with: node scripts/codegen/gen-federal-tax-tables.mjs
// A CI check (--check) fails the build if this file drifts from the source.
import type { FilingStatus } from '../types';

export interface FederalYearTable {
  ordinary: Record<FilingStatus, { min: number; rate: number }[]>;
  ltcg: Record<FilingStatus, { min: number; rate: number }[]>;
  stdDeduction: Record<FilingStatus, number>;
  amt: {
    rateLower: number;
    rateUpper: number;
    phaseoutRate: number;
    breakpoint: number;
    exemption: Record<FilingStatus, number>;
    phaseoutStart: Record<FilingStatus, number>;
  };
  fica: { ssWageBase: number; ssRate: number; medicareRate: number; addlMedicareRate: number };
  niit: { rate: number; threshold: Record<FilingStatus, number> };
  addlMedicareThreshold: Record<FilingStatus, number>;
}

export const DEFAULT_TAX_YEAR = 2026;

export const FEDERAL_TAX_TABLES: Record<number, FederalYearTable> = {
  "2018": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 9525,
          "rate": 0.12
        },
        {
          "min": 38700,
          "rate": 0.22
        },
        {
          "min": 82500,
          "rate": 0.24
        },
        {
          "min": 157500,
          "rate": 0.32
        },
        {
          "min": 200000,
          "rate": 0.35
        },
        {
          "min": 500000,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 19050,
          "rate": 0.12
        },
        {
          "min": 77400,
          "rate": 0.22
        },
        {
          "min": 165000,
          "rate": 0.24
        },
        {
          "min": 315000,
          "rate": 0.32
        },
        {
          "min": 400000,
          "rate": 0.35
        },
        {
          "min": 600000,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 13600,
          "rate": 0.12
        },
        {
          "min": 51800,
          "rate": 0.22
        },
        {
          "min": 82500,
          "rate": 0.24
        },
        {
          "min": 157500,
          "rate": 0.32
        },
        {
          "min": 200000,
          "rate": 0.35
        },
        {
          "min": 500000,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 38600,
          "rate": 0.15
        },
        {
          "min": 425800,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 77200,
          "rate": 0.15
        },
        {
          "min": 479000,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 51700,
          "rate": 0.15
        },
        {
          "min": 452400,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 12000,
      "married_joint": 24000,
      "head_household": 18000
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 191500,
      "exemption": {
        "single": 70300,
        "married_joint": 109400,
        "head_household": 70300
      },
      "phaseoutStart": {
        "single": 500000,
        "married_joint": 1000000,
        "head_household": 500000
      }
    },
    "fica": {
      "ssWageBase": 128400,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2019": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 9701,
          "rate": 0.12
        },
        {
          "min": 39476,
          "rate": 0.22
        },
        {
          "min": 84201,
          "rate": 0.24
        },
        {
          "min": 160726,
          "rate": 0.32
        },
        {
          "min": 204101,
          "rate": 0.35
        },
        {
          "min": 510300,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 19401,
          "rate": 0.12
        },
        {
          "min": 78951,
          "rate": 0.22
        },
        {
          "min": 168401,
          "rate": 0.24
        },
        {
          "min": 321451,
          "rate": 0.32
        },
        {
          "min": 408201,
          "rate": 0.35
        },
        {
          "min": 612350,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 13851,
          "rate": 0.12
        },
        {
          "min": 52851,
          "rate": 0.22
        },
        {
          "min": 84201,
          "rate": 0.24
        },
        {
          "min": 160701,
          "rate": 0.32
        },
        {
          "min": 204101,
          "rate": 0.35
        },
        {
          "min": 510300,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 39375,
          "rate": 0.15
        },
        {
          "min": 434550,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 78750,
          "rate": 0.15
        },
        {
          "min": 488850,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 39375,
          "rate": 0.15
        },
        {
          "min": 434550,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 12200,
      "married_joint": 24400,
      "head_household": 18350
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 194800,
      "exemption": {
        "single": 71700,
        "married_joint": 111700,
        "head_household": 71700
      },
      "phaseoutStart": {
        "single": 510300,
        "married_joint": 1020600,
        "head_household": 510300
      }
    },
    "fica": {
      "ssWageBase": 132900,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2020": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 9876,
          "rate": 0.12
        },
        {
          "min": 40126,
          "rate": 0.22
        },
        {
          "min": 85526,
          "rate": 0.24
        },
        {
          "min": 163301,
          "rate": 0.32
        },
        {
          "min": 207351,
          "rate": 0.35
        },
        {
          "min": 518401,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 19751,
          "rate": 0.12
        },
        {
          "min": 80251,
          "rate": 0.22
        },
        {
          "min": 171051,
          "rate": 0.24
        },
        {
          "min": 326601,
          "rate": 0.32
        },
        {
          "min": 414701,
          "rate": 0.35
        },
        {
          "min": 622051,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 14101,
          "rate": 0.12
        },
        {
          "min": 53701,
          "rate": 0.22
        },
        {
          "min": 85501,
          "rate": 0.24
        },
        {
          "min": 163301,
          "rate": 0.32
        },
        {
          "min": 207351,
          "rate": 0.35
        },
        {
          "min": 518401,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 40000,
          "rate": 0.15
        },
        {
          "min": 441450,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 80000,
          "rate": 0.15
        },
        {
          "min": 496600,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 53600,
          "rate": 0.15
        },
        {
          "min": 469050,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 12400,
      "married_joint": 24800,
      "head_household": 18650
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 197900,
      "exemption": {
        "single": 72900,
        "married_joint": 113400,
        "head_household": 72900
      },
      "phaseoutStart": {
        "single": 518400,
        "married_joint": 1036800,
        "head_household": 518400
      }
    },
    "fica": {
      "ssWageBase": 137700,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2021": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 9951,
          "rate": 0.12
        },
        {
          "min": 40526,
          "rate": 0.22
        },
        {
          "min": 86376,
          "rate": 0.24
        },
        {
          "min": 164926,
          "rate": 0.32
        },
        {
          "min": 209426,
          "rate": 0.35
        },
        {
          "min": 523600,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 19901,
          "rate": 0.12
        },
        {
          "min": 81051,
          "rate": 0.22
        },
        {
          "min": 172751,
          "rate": 0.24
        },
        {
          "min": 329851,
          "rate": 0.32
        },
        {
          "min": 418851,
          "rate": 0.35
        },
        {
          "min": 628300,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 14201,
          "rate": 0.12
        },
        {
          "min": 54201,
          "rate": 0.22
        },
        {
          "min": 86351,
          "rate": 0.24
        },
        {
          "min": 164901,
          "rate": 0.32
        },
        {
          "min": 209401,
          "rate": 0.35
        },
        {
          "min": 523600,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 40400,
          "rate": 0.15
        },
        {
          "min": 445850,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 80800,
          "rate": 0.15
        },
        {
          "min": 501600,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 54100,
          "rate": 0.15
        },
        {
          "min": 473750,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 12550,
      "married_joint": 25100,
      "head_household": 18800
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 199900,
      "exemption": {
        "single": 73600,
        "married_joint": 114600,
        "head_household": 73600
      },
      "phaseoutStart": {
        "single": 523600,
        "married_joint": 1047200,
        "head_household": 523600
      }
    },
    "fica": {
      "ssWageBase": 142800,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2022": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 10275,
          "rate": 0.12
        },
        {
          "min": 41775,
          "rate": 0.22
        },
        {
          "min": 89075,
          "rate": 0.24
        },
        {
          "min": 170050,
          "rate": 0.32
        },
        {
          "min": 215950,
          "rate": 0.35
        },
        {
          "min": 539900,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 20550,
          "rate": 0.12
        },
        {
          "min": 83550,
          "rate": 0.22
        },
        {
          "min": 178150,
          "rate": 0.24
        },
        {
          "min": 340100,
          "rate": 0.32
        },
        {
          "min": 431900,
          "rate": 0.35
        },
        {
          "min": 647850,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 14650,
          "rate": 0.12
        },
        {
          "min": 55900,
          "rate": 0.22
        },
        {
          "min": 89050,
          "rate": 0.24
        },
        {
          "min": 170050,
          "rate": 0.32
        },
        {
          "min": 215950,
          "rate": 0.35
        },
        {
          "min": 539900,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 41675,
          "rate": 0.15
        },
        {
          "min": 459750,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 83350,
          "rate": 0.15
        },
        {
          "min": 517200,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 55800,
          "rate": 0.15
        },
        {
          "min": 488500,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 12950,
      "married_joint": 25900,
      "head_household": 19400
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 206100,
      "exemption": {
        "single": 75900,
        "married_joint": 118100,
        "head_household": 75900
      },
      "phaseoutStart": {
        "single": 539900,
        "married_joint": 1079800,
        "head_household": 539900
      }
    },
    "fica": {
      "ssWageBase": 147000,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2023": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 11000,
          "rate": 0.12
        },
        {
          "min": 44725,
          "rate": 0.22
        },
        {
          "min": 95375,
          "rate": 0.24
        },
        {
          "min": 182100,
          "rate": 0.32
        },
        {
          "min": 231250,
          "rate": 0.35
        },
        {
          "min": 578125,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 22000,
          "rate": 0.12
        },
        {
          "min": 89450,
          "rate": 0.22
        },
        {
          "min": 190750,
          "rate": 0.24
        },
        {
          "min": 364200,
          "rate": 0.32
        },
        {
          "min": 462500,
          "rate": 0.35
        },
        {
          "min": 693750,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 15700,
          "rate": 0.12
        },
        {
          "min": 59850,
          "rate": 0.22
        },
        {
          "min": 95350,
          "rate": 0.24
        },
        {
          "min": 182100,
          "rate": 0.32
        },
        {
          "min": 231250,
          "rate": 0.35
        },
        {
          "min": 578100,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 44625,
          "rate": 0.15
        },
        {
          "min": 492300,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 89250,
          "rate": 0.15
        },
        {
          "min": 553850,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 59750,
          "rate": 0.15
        },
        {
          "min": 523050,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 13850,
      "married_joint": 27700,
      "head_household": 20800
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 220700,
      "exemption": {
        "single": 81300,
        "married_joint": 126500,
        "head_household": 81300
      },
      "phaseoutStart": {
        "single": 578150,
        "married_joint": 1156300,
        "head_household": 578150
      }
    },
    "fica": {
      "ssWageBase": 160200,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2024": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 11600,
          "rate": 0.12
        },
        {
          "min": 47150,
          "rate": 0.22
        },
        {
          "min": 100525,
          "rate": 0.24
        },
        {
          "min": 191950,
          "rate": 0.32
        },
        {
          "min": 243725,
          "rate": 0.35
        },
        {
          "min": 609350,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 23200,
          "rate": 0.12
        },
        {
          "min": 94300,
          "rate": 0.22
        },
        {
          "min": 201050,
          "rate": 0.24
        },
        {
          "min": 383900,
          "rate": 0.32
        },
        {
          "min": 487450,
          "rate": 0.35
        },
        {
          "min": 731200,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 16550,
          "rate": 0.12
        },
        {
          "min": 63100,
          "rate": 0.22
        },
        {
          "min": 100500,
          "rate": 0.24
        },
        {
          "min": 191950,
          "rate": 0.32
        },
        {
          "min": 243700,
          "rate": 0.35
        },
        {
          "min": 609350,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 47025,
          "rate": 0.15
        },
        {
          "min": 518900,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 94050,
          "rate": 0.15
        },
        {
          "min": 583750,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 63000,
          "rate": 0.15
        },
        {
          "min": 551350,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 14600,
      "married_joint": 29200,
      "head_household": 21900
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 232600,
      "exemption": {
        "single": 85700,
        "married_joint": 133300,
        "head_household": 85700
      },
      "phaseoutStart": {
        "single": 609350,
        "married_joint": 1218700,
        "head_household": 609350
      }
    },
    "fica": {
      "ssWageBase": 168600,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2025": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 11925,
          "rate": 0.12
        },
        {
          "min": 48475,
          "rate": 0.22
        },
        {
          "min": 103350,
          "rate": 0.24
        },
        {
          "min": 197300,
          "rate": 0.32
        },
        {
          "min": 250525,
          "rate": 0.35
        },
        {
          "min": 626350,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 23850,
          "rate": 0.12
        },
        {
          "min": 96950,
          "rate": 0.22
        },
        {
          "min": 206700,
          "rate": 0.24
        },
        {
          "min": 394600,
          "rate": 0.32
        },
        {
          "min": 501050,
          "rate": 0.35
        },
        {
          "min": 751600,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 17000,
          "rate": 0.12
        },
        {
          "min": 64850,
          "rate": 0.22
        },
        {
          "min": 103350,
          "rate": 0.24
        },
        {
          "min": 197300,
          "rate": 0.32
        },
        {
          "min": 250500,
          "rate": 0.35
        },
        {
          "min": 626350,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 48350,
          "rate": 0.15
        },
        {
          "min": 533400,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 96700,
          "rate": 0.15
        },
        {
          "min": 600050,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 64750,
          "rate": 0.15
        },
        {
          "min": 566700,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 15000,
      "married_joint": 30000,
      "head_household": 22500
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.25,
      "breakpoint": 239100,
      "exemption": {
        "single": 88100,
        "married_joint": 137000,
        "head_household": 88100
      },
      "phaseoutStart": {
        "single": 626350,
        "married_joint": 1252700,
        "head_household": 626350
      }
    },
    "fica": {
      "ssWageBase": 176100,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  },
  "2026": {
    "ordinary": {
      "single": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 12400,
          "rate": 0.12
        },
        {
          "min": 50400,
          "rate": 0.22
        },
        {
          "min": 105700,
          "rate": 0.24
        },
        {
          "min": 201775,
          "rate": 0.32
        },
        {
          "min": 256225,
          "rate": 0.35
        },
        {
          "min": 640600,
          "rate": 0.37
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 24800,
          "rate": 0.12
        },
        {
          "min": 100800,
          "rate": 0.22
        },
        {
          "min": 211400,
          "rate": 0.24
        },
        {
          "min": 403550,
          "rate": 0.32
        },
        {
          "min": 512450,
          "rate": 0.35
        },
        {
          "min": 768700,
          "rate": 0.37
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0.1
        },
        {
          "min": 17700,
          "rate": 0.12
        },
        {
          "min": 67450,
          "rate": 0.22
        },
        {
          "min": 105700,
          "rate": 0.24
        },
        {
          "min": 201775,
          "rate": 0.32
        },
        {
          "min": 256200,
          "rate": 0.35
        },
        {
          "min": 640600,
          "rate": 0.37
        }
      ]
    },
    "ltcg": {
      "single": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 49450,
          "rate": 0.15
        },
        {
          "min": 545500,
          "rate": 0.2
        }
      ],
      "married_joint": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 98900,
          "rate": 0.15
        },
        {
          "min": 613700,
          "rate": 0.2
        }
      ],
      "head_household": [
        {
          "min": 0,
          "rate": 0
        },
        {
          "min": 66200,
          "rate": 0.15
        },
        {
          "min": 579600,
          "rate": 0.2
        }
      ]
    },
    "stdDeduction": {
      "single": 16100,
      "married_joint": 32200,
      "head_household": 24150
    },
    "amt": {
      "rateLower": 0.26,
      "rateUpper": 0.28,
      "phaseoutRate": 0.5,
      "breakpoint": 244500,
      "exemption": {
        "single": 90100,
        "married_joint": 140200,
        "head_household": 90100
      },
      "phaseoutStart": {
        "single": 500000,
        "married_joint": 1000000,
        "head_household": 500000
      }
    },
    "fica": {
      "ssWageBase": 184500,
      "ssRate": 0.062,
      "medicareRate": 0.0145,
      "addlMedicareRate": 0.009
    },
    "niit": {
      "rate": 0.038,
      "threshold": {
        "single": 200000,
        "married_joint": 250000,
        "head_household": 200000
      }
    },
    "addlMedicareThreshold": {
      "single": 200000,
      "married_joint": 250000,
      "head_household": 200000
    }
  }
};

export const FEDERAL_TAX_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] as const;

export const CURRENT_FEDERAL_TABLE = FEDERAL_TAX_TABLES[DEFAULT_TAX_YEAR];
