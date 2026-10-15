W,S,E,N = 83.55, 25.55, 85.55, 27.95
RES = 0.0006
import numpy as np
from rasterio.transform import from_origin
WIDTH = int(round((E-W)/RES)); HEIGHT = int(round((N-S)/RES))
TR = from_origin(W, N, RES, RES)
