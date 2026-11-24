#!/usr/bin/env python3
"""1D Drude ADE-FDTD benchmark vs analytical TMM on Luebbers 1991 plasma slab.

Reference papers:
  - 3CMZCDDL: Luebbers et al. (1991), Electromagnetic-wave propagation in unmagnetized plasmas
  - YT6UVX53: Auxiliary differential equation / dispersive FDTD formulations

Saves full time-domain & frequency-domain arrays + analytical TMM reference + error curves
into --out (.npz), and prints a single JSON summary line to stdout.
"""
import argparse
import json
import os
import sys
import time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench_plasma_tmm_1d import solve_tmm_1d, C0, BACKEND  # noqa: E402

EPS0 = 8.8541878128e-12
MU0 = 4.0 * np.pi * 1e-7
ETA0 = np.sqrt(MU0 / EPS0)


def run_ade_fdtd_1d(thickness_m=0.015, fp_ghz=28.7, nu_c_ghz=20.0, dz=7.5e-5, nsteps=3200):
    """Run 1D Drude ADE-FDTD with Mur 1st-order ABC and reference free-space run."""
    dt = 0.5 * dz / C0  # Courant S = 0.5
    n_slab = int(round(thickness_m / dz))
    pad_left = 180
    pad_right = 180
    nz = pad_left + n_slab + pad_right
    i_src = 40
    i_ref = 100
    i_trn = pad_left + n_slab + 60

    omega_p = 2.0 * np.pi * fp_ghz * 1e9
    nu_c = nu_c_ghz * 1e9

    # Semi-implicit trapezoidal ADE update for J:
    # dJ/dt + nu_c * J = eps0 * omega_p^2 * E
    # J^{n+1/2} = k_p * J^{n-1/2} + beta_p * E^n
    k_p = (1.0 - 0.5 * nu_c * dt) / (1.0 + 0.5 * nu_c * dt)
    beta_p = (EPS0 * (omega_p ** 2) * dt) / (1.0 + 0.5 * nu_c * dt)

    # Gaussian pulse covering up to > 100 GHz
    t0 = 45.0 * dt
    spread = 9.0 * dt

    def simulate(with_slab):
        Ez = np.zeros(nz, dtype=np.float64)
        Hy = np.zeros(nz - 1, dtype=np.float64)
        Jz = np.zeros(nz, dtype=np.float64)
        c_e = dt / (EPS0 * dz)
        c_h = dt / (MU0 * dz)
        mur = (C0 * dt - dz) / (C0 * dt + dz)

        e_ref = np.zeros(nsteps, dtype=np.float64)
        e_trn = np.zeros(nsteps, dtype=np.float64)
        s0, s1 = pad_left, pad_left + n_slab

        for n in range(nsteps):
            # Update H^{n+1/2}
            Hy += c_h * (Ez[1:] - Ez[:-1])

            # Soft Gaussian source on Ez
            pulse = np.exp(-0.5 * (((n * dt) - t0) / spread) ** 2)

            ez_left_old = Ez[1]
            ez_right_old = Ez[-2]

            if with_slab:
                # Update J^{n+1/2} inside plasma slab using Ez^n
                Jz[s0:s1] = k_p * Jz[s0:s1] + beta_p * Ez[s0:s1]
                # Update E^{n+1}
                Ez[1:-1] += c_e * (Hy[1:] - Hy[:-1]) - (dt / EPS0) * Jz[1:-1]
            else:
                Ez[1:-1] += c_e * (Hy[1:] - Hy[:-1])

            Ez[i_src] += pulse

            # 1st-order Mur ABC at both ends (free space)
            Ez[0] = ez_left_old + mur * (Ez[1] - Ez[0])
            Ez[-1] = ez_right_old + mur * (Ez[-2] - Ez[-1])

            e_ref[n] = Ez[i_ref]
            e_trn[n] = Ez[i_trn]

        return e_ref, e_trn

    inc_ref, inc_trn = simulate(with_slab=False)
    tot_ref, tot_trn = simulate(with_slab=True)
    scat_ref = tot_ref - inc_ref

    # DFT on target frequency grid (5 - 80 GHz)
    freq_ghz = np.linspace(5.0, 80.0, 151)
    omega = 2.0 * np.pi * freq_ghz * 1e9
    t_arr = np.arange(nsteps, dtype=np.float64) * dt
    # exp(-j*omega*t) DFT matrix
    kern = np.exp(-1j * np.outer(omega, t_arr))

    E_inc_ref = kern @ inc_ref
    E_scat_ref = kern @ scat_ref
    E_inc_trn = kern @ inc_trn
    E_tot_trn = kern @ tot_trn

    # Phase shift reference plane to slab front/back faces
    dist_ref = (pad_left - i_ref) * dz
    R_fdtd = (E_scat_ref / E_inc_ref) * np.exp(1j * (omega / C0) * 2.0 * dist_ref)
    T_fdtd = (E_tot_trn / E_inc_trn) * np.exp(1j * (omega / C0) * thickness_m)

    return {
        "freq_ghz": freq_ghz,
        "R_fdtd": R_fdtd,
        "T_fdtd": T_fdtd,
        "inc_ref": inc_ref,
        "scat_ref": scat_ref,
        "tot_trn": tot_trn,
        "dt": dt,
        "dz": dz,
        "nsteps": nsteps,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output .npz path")
    args = ap.parse_args()

    t0 = time.perf_counter()
    params = {"thickness_m": 0.015, "fp_ghz": 28.7, "nu_c_ghz": 20.0, "dz": 7.5e-5, "nsteps": 3200}
    fdtd = run_ade_fdtd_1d(**params)
    tmm = solve_tmm_1d(fdtd["freq_ghz"], params["thickness_m"], params["fp_ghz"], params["nu_c_ghz"])
    elapsed_s = time.perf_counter() - t0

    R_fdtd_db = 20.0 * np.log10(np.maximum(np.abs(fdtd["R_fdtd"]), 1e-15))
    T_fdtd_db = 20.0 * np.log10(np.maximum(np.abs(fdtd["T_fdtd"]), 1e-15))
    R_err_db = R_fdtd_db - tmm["R_db"]
    T_err_db = T_fdtd_db - tmm["T_db"]

    # Evaluate accuracy across frequencies where signal is above -35 dB
    r_mask = tmm["R_db"] > -35.0
    t_mask = tmm["T_db"] > -35.0
    r_rmse = float(np.sqrt(np.mean(R_err_db[r_mask] ** 2)))
    t_rmse = float(np.sqrt(np.mean(T_err_db[t_mask] ** 2)))
    r_max = float(np.max(np.abs(R_err_db[r_mask])))
    t_max = float(np.max(np.abs(T_err_db[t_mask])))

    status = "reproduced" if (r_rmse < 0.5 and t_rmse < 0.5) else "mismatch"

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    np.savez_compressed(
        args.out,
        freq_ghz=fdtd["freq_ghz"],
        R_fdtd_complex=fdtd["R_fdtd"],
        T_fdtd_complex=fdtd["T_fdtd"],
        R_fdtd_db=R_fdtd_db,
        T_fdtd_db=T_fdtd_db,
        R_tmm_db=tmm["R_db"],
        T_tmm_db=tmm["T_db"],
        R_err_db=R_err_db,
        T_err_db=T_err_db,
        inc_ref=fdtd["inc_ref"],
        scat_ref=fdtd["scat_ref"],
        tot_trn=fdtd["tot_trn"],
        dt=np.array(fdtd["dt"]),
        dz=np.array(fdtd["dz"]),
        params_json=np.array(json.dumps(params, ensure_ascii=False)),
        backend=np.array(BACKEND),
        elapsed_s=np.array(elapsed_s),
    )

    summary = {
        "id": "bench_plasma_ade_fdtd_1d",
        "title": "1D Drude ADE-FDTD 时域求解器 vs TMM 解析解基准 (Luebbers 1991)",
        "zoteroKeys": ["3CMZCDDL", "YT6UVX53"],
        "npzPath": os.path.abspath(args.out),
        "status": status,
        "errorSummary": (
            f"5-80GHz vs TMM: R RMSE={r_rmse:.3f}dB (max {r_max:.3f}dB), "
            f"T RMSE={t_rmse:.3f}dB (max {t_max:.3f}dB), "
            f"backend={BACKEND}, elapsed={elapsed_s:.2f}s"
        ),
        "metrics": {
            "R_rmse_db": r_rmse,
            "T_rmse_db": t_rmse,
            "R_max_err_db": r_max,
            "T_max_err_db": t_max,
            "backend": BACKEND,
            "elapsed_s": elapsed_s,
        },
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
