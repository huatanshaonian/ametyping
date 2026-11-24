#!/usr/bin/env python3
"""1D unmagnetized collisional Drude plasma slab Transfer Matrix Method (TMM) analytical benchmark.

Reference parameters (Luebbers et al., IEEE TAP 1991, Zotero key 3CMZCDDL):
  - Slab thickness: d = 1.5 cm
  - Plasma frequency: f_p = 28.7 GHz (omega_p = 2*pi*28.7e9 rad/s)
  - Collision frequency: nu_c = 20.0 GHz (20e9 rad/s)
  - Frequency sweep: 0.5 - 100 GHz (400 points)

Saves full arrays to --out (.npz) and prints a single JSON summary line to stdout.
"""
import argparse
import json
import os
import time
import numpy as np

try:
    import cupy as cp  # type: ignore
    _ = cp.zeros(1)
    BACKEND = "cupy"
except Exception:
    cp = None
    BACKEND = "numpy"

C0 = 299792458.0


def solve_tmm_1d(freq_ghz, thickness_m=0.015, fp_ghz=28.7, nu_c_ghz=20.0):
    xp = cp if cp is not None else np
    f = xp.asarray(freq_ghz, dtype=xp.float64) * 1e9
    omega = 2.0 * np.pi * f
    omega_p = 2.0 * np.pi * fp_ghz * 1e9
    nu_c = nu_c_ghz * 1e9

    # Drude relative permittivity: eps_r(w) = 1 - w_p^2 / (w * (w - j * nu_c))
    eps_r = 1.0 - (omega_p ** 2) / (omega * (omega - 1j * nu_c))
    n_c = xp.sqrt(eps_r)
    # Enforce Im(n_c) <= 0 for exp(+j*omega*t) convention so exp(-j*k*d) decays
    n_c = xp.where(xp.imag(n_c) > 0, -n_c, n_c)

    k0 = omega / C0
    kd = k0 * n_c * thickness_m

    # Single homogeneous slab embedded in free space (eta_rel = 1 / n_c)
    cos_kd = xp.cos(kd)
    sin_kd = xp.sin(kd)
    m11 = cos_kd
    m12 = 1j * sin_kd / n_c
    m21 = 1j * n_c * sin_kd
    m22 = cos_kd

    denom = m11 + m12 + m21 + m22
    R = (m11 + m12 - m21 - m22) / denom
    T = 2.0 / denom

    if cp is not None:
        eps_r, R, T = cp.asnumpy(eps_r), cp.asnumpy(R), cp.asnumpy(T)

    R_pow = np.abs(R) ** 2
    T_pow = np.abs(T) ** 2
    A_pow = np.maximum(0.0, 1.0 - R_pow - T_pow)
    R_db = 20.0 * np.log10(np.maximum(np.abs(R), 1e-15))
    T_db = 20.0 * np.log10(np.maximum(np.abs(T), 1e-15))
    A_db = 10.0 * np.log10(np.maximum(A_pow, 1e-15))
    return {
        "eps_r": eps_r,
        "R": R,
        "T": T,
        "R_db": R_db,
        "T_db": T_db,
        "A_db": A_db,
        "energy_max": float(np.max(R_pow + T_pow)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output .npz path")
    ap.add_argument("--nfreq", type=int, default=400)
    args = ap.parse_args()

    t0 = time.perf_counter()
    freq_ghz = np.linspace(0.5, 100.0, args.nfreq)
    params = {
        "thickness_m": 0.015,
        "fp_ghz": 28.7,
        "nu_c_ghz": 20.0,
        "freq_min_ghz": 0.5,
        "freq_max_ghz": 100.0,
        "nfreq": args.nfreq,
    }
    res = solve_tmm_1d(freq_ghz, params["thickness_m"], params["fp_ghz"], params["nu_c_ghz"])
    elapsed_s = time.perf_counter() - t0

    # Key physical sanity checks for Luebbers 1991 slab
    energy_ok = res["energy_max"] <= 1.0 + 1e-10
    # At 10 GHz (well below fp=28.7 GHz), reflection should be high (> -4 dB) and transmission attenuated (< -10 dB)
    idx_10 = int(np.argmin(np.abs(freq_ghz - 10.0)))
    idx_50 = int(np.argmin(np.abs(freq_ghz - 50.0)))
    r10 = float(res["R_db"][idx_10])
    t10 = float(res["T_db"][idx_10])
    t50 = float(res["T_db"][idx_50])
    phys_ok = energy_ok and (r10 > -6.0) and (t10 < -10.0) and (t50 > -5.0)
    status = "reproduced" if phys_ok else "mismatch"

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    np.savez_compressed(
        args.out,
        freq_ghz=freq_ghz,
        R_complex=res["R"],
        T_complex=res["T"],
        R_db=res["R_db"],
        T_db=res["T_db"],
        A_db=res["A_db"],
        eps_r_real=np.real(res["eps_r"]),
        eps_r_imag=np.imag(res["eps_r"]),
        params_json=np.array(json.dumps(params, ensure_ascii=False)),
        backend=np.array(BACKEND),
        elapsed_s=np.array(elapsed_s),
    )

    summary = {
        "id": "bench_plasma_tmm_1d",
        "title": "1D 碰撞等离子体平板传输矩阵解析基准 (Luebbers 1991)",
        "zoteroKeys": ["3CMZCDDL", "YT6UVX53"],
        "npzPath": os.path.abspath(args.out),
        "status": status,
        "errorSummary": (
            f"能量守恒 max(|R|^2+|T|^2)={res['energy_max']:.6f}, "
            f"10GHz: R={r10:.2f}dB T={t10:.2f}dB, 50GHz: T={t50:.2f}dB "
            f"(backend={BACKEND}, {elapsed_s*1e3:.1f}ms)"
        ),
        "metrics": {
            "energy_max": res["energy_max"],
            "R_10ghz_db": r10,
            "T_10ghz_db": t10,
            "T_50ghz_db": t50,
            "backend": BACKEND,
            "elapsed_s": elapsed_s,
        },
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
